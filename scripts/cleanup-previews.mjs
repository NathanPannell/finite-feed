import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

function required(environment, key) {
  if (!environment[key]) throw new Error(`Missing required variable: ${key}`);
  return environment[key];
}

export function previewTargets(environment) {
  const raw = environment.PREVIEW_PULL_REQUEST_FILE
    ? readFileSync(environment.PREVIEW_PULL_REQUEST_FILE, "utf8")
    : required(environment, "PREVIEW_PULL_REQUEST");
  const values = raw.split(/[\s,]+/).filter(Boolean);
  if ((!values.length && !environment.PREVIEW_PULL_REQUEST_FILE) || values.some((value) => !/^[1-9][0-9]*$/.test(value))) {
    throw new Error("Preview cleanup requires positive PR numbers");
  }
  return new Set(values);
}

function findNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) findNames(item, names);
  } else if (value && typeof value === "object") {
    if (typeof value.name === "string") names.add(value.name);
    for (const item of Object.values(value)) findNames(item, names);
  }
  return names;
}

async function timedFetch(fetchImpl, url, options = {}, timeoutMs = 20_000) {
  return fetchImpl(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
}

async function responseJson(fetchImpl, url, options, operation) {
  let response;
  try {
    response = await timedFetch(fetchImpl, url, options);
  } catch {
    throw new Error(`${operation} timed out or failed`);
  }
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

export async function cleanupRailway({ environment, targets, execute }) {
  await execute(["link", "--project", required(environment, "RAILWAY_PROJECT_ID"), "--environment", required(environment, "RAILWAY_BASE_ENVIRONMENT_ID")]);
  let listing;
  try {
    listing = JSON.parse(await execute(["environment", "list", "--json"]));
  } catch {
    throw new Error("Could not list Railway preview environments");
  }
  const names = findNames(listing);
  const failures = [];
  let removed = 0;
  for (const pr of targets) {
    const name = `pr-${pr}`;
    if (!names.has(name)) continue;
    try {
      await execute(["environment", "delete", name, "--yes"]);
      removed += 1;
    } catch {
      failures.push(`Railway ${name}`);
    }
  }
  if (failures.length) throw new AggregateError([], `Failed cleanup: ${failures.join(", ")}`);
  return removed;
}

export async function cleanupNeon({ environment, targets, fetchImpl }) {
  const project = required(environment, "NEON_PROJECT_ID");
  const headers = { Authorization: `Bearer ${required(environment, "NEON_API_KEY")}` };
  const failures = [];
  let removed = 0;
  let cursor = "";
  const seen = new Set();
  do {
    const url = new URL(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(project)}/branches`);
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const page = await responseJson(fetchImpl, url, { headers }, "Neon branch listing");
    if (!Array.isArray(page.branches)) throw new Error("Neon branch listing returned an invalid shape");
    for (const branch of page.branches) {
      const match = typeof branch.name === "string" && branch.name.match(/^preview\/pr-([1-9][0-9]*)$/);
      if (!match || !targets.has(match[1]) || typeof branch.id !== "string" || !/^br-[a-z0-9-]+$/.test(branch.id)) continue;
      const deleteUrl = new URL(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(project)}/branches/${encodeURIComponent(branch.id)}`);
      try {
        const response = await timedFetch(fetchImpl, deleteUrl, { method: "DELETE", headers });
        if (!response.ok && response.status !== 404) throw new Error();
        removed += 1;
      } catch {
        failures.push(`Neon ${branch.name}`);
      }
    }
    const next = page.pagination?.next || page.pagination?.cursor || "";
    if (next && seen.has(next)) throw new Error("Neon branch pagination repeated a cursor");
    if (next) seen.add(next);
    cursor = next;
  } while (cursor);
  if (failures.length) throw new AggregateError([], `Failed cleanup: ${failures.join(", ")}`);
  return removed;
}

export async function cleanupVercel({ environment, targets, fetchImpl }) {
  const repository = required(environment, "GITHUB_REPOSITORY");
  const project = required(environment, "VERCEL_PROJECT_ID");
  const team = required(environment, "VERCEL_ORG_ID");
  const headers = { Authorization: `Bearer ${required(environment, "VERCEL_TOKEN")}` };
  const failures = [];
  const candidates = new Set();
  const untaggedProjectPreviewIds = new Set();
  const legacyIds = new Set((environment.VERCEL_LEGACY_DEPLOYMENT_IDS || "").split(/[\s,]+/).filter(Boolean));
  if ([...legacyIds].some((id) => !/^dpl_[A-Za-z0-9]+$/.test(id))) throw new Error("Invalid legacy Vercel deployment ID");
  let removed = 0;
  let until = "";
  const seen = new Set();
  do {
    const url = new URL("https://api.vercel.com/v7/deployments");
    url.searchParams.set("projectId", project);
    url.searchParams.set("teamId", team);
    url.searchParams.set("target", "preview");
    url.searchParams.set("limit", "100");
    if (until) url.searchParams.set("until", until);
    const page = await responseJson(fetchImpl, url, { headers }, "Vercel deployment listing");
    if (!Array.isArray(page.deployments)) throw new Error("Vercel deployment listing returned an invalid shape");
    for (const deployment of page.deployments) {
      const id = deployment.uid;
      if (deployment.projectId === project && deployment.target !== "production" && typeof id === "string" && /^dpl_[A-Za-z0-9]+$/.test(id)) {
        const hasPreviewTag = deployment.meta?.previewRepository !== undefined || deployment.meta?.previewPullRequest !== undefined;
        if (!hasPreviewTag) untaggedProjectPreviewIds.add(id);
      }
      const pr = String(deployment.meta?.previewPullRequest || "");
      if (deployment.projectId !== project || deployment.target === "production" || deployment.meta?.previewRepository !== repository || !targets.has(pr)) continue;
      if (typeof id !== "string" || !/^dpl_[A-Za-z0-9]+$/.test(id)) continue;
      candidates.add(id);
    }
    const next = page.pagination?.next ? String(page.pagination.next) : "";
    if (next && seen.has(next)) throw new Error("Vercel deployment pagination repeated a cursor");
    if (next) seen.add(next);
    until = next;
  } while (until);
  for (const id of legacyIds) {
    if (untaggedProjectPreviewIds.has(id)) candidates.add(id);
  }
  for (const id of candidates) {
    try {
      const deleteUrl = new URL(`https://api.vercel.com/v13/deployments/${encodeURIComponent(id)}`);
      deleteUrl.searchParams.set("teamId", team);
      const response = await timedFetch(fetchImpl, deleteUrl, { method: "DELETE", headers });
      if (!response.ok && ![404, 410].includes(response.status)) throw new Error();
      removed += 1;
    } catch {
      failures.push(`Vercel ${id}`);
    }
  }
  if (failures.length) throw new AggregateError([], `Failed cleanup: ${failures.join(", ")}`);
  return removed;
}

export async function cleanupPreviews({ environment, execute, fetchImpl }) {
  const targets = previewTargets(environment);
  const results = await Promise.allSettled([
    cleanupRailway({ environment, targets, execute }),
    cleanupNeon({ environment, targets, fetchImpl }),
    cleanupVercel({ environment, targets, fetchImpl }),
  ]);
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason?.message || "unknown provider failure");
  if (failures.length) throw new AggregateError([], failures.join("; "));
  return { railway: results[0].value, neon: results[1].value, vercel: results[2].value };
}

export function railwayCommand(args, run = execFile, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    run("railway", args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error(`Railway ${args.slice(0, 2).join(" ")} failed`));
      else resolve(stdout);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const counts = await cleanupPreviews({ environment: process.env, execute: railwayCommand, fetchImpl: fetch });
    console.log(`Preview cleanup completed (Railway ${counts.railway}, Neon ${counts.neon}, Vercel ${counts.vercel}).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
