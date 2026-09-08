import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function required(environment, key) {
  if (!environment[key]) throw new Error(`Missing required variable: ${key}`);
  return environment[key];
}

function exactHttpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function domainOrigins(payload, found = new Set()) {
  if (Array.isArray(payload)) for (const item of payload) domainOrigins(item, found);
  else if (payload && typeof payload === "object") for (const item of Object.values(payload)) domainOrigins(item, found);
  else if (typeof payload === "string") {
    const origin = exactHttpsOrigin(payload);
    if (origin) found.add(origin);
  }
  return found;
}

function neon(args) {
  try {
    return execFileSync("neon", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, windowsHide: true });
  } catch {
    throw new Error("Neon Auth trusted-domain command failed.");
  }
}

function listDomains(project, execute) {
  let payload;
  try {
    payload = JSON.parse(execute(["neon-auth", "domain", "list", "--project-id", project, "--branch", "staging", "--output", "json", "--no-color"]));
  } catch {
    throw new Error("Could not read Neon staging Auth trusted domains.");
  }
  return domainOrigins(payload);
}

export function reconcileNeonStagingDomains(environment, execute = neon) {
  const project = required(environment, "NEON_PROJECT_ID");
  if (required(environment, "NEON_BRANCH") !== "staging") throw new Error("Neon staging branch must be named staging.");
  const expected = new Set([
    exactHttpsOrigin(required(environment, "STAGING_FRONTEND_URL")),
    exactHttpsOrigin(required(environment, "STAGING_DEPLOYMENT_URL")),
  ]);
  if (expected.has(null)) throw new Error("Staging trusted domains must be exact HTTPS origins.");

  const before = listDomains(project, execute);
  for (const origin of expected) {
    if (!before.has(origin)) execute(["neon-auth", "domain", "add", origin, "--project-id", project, "--branch", "staging", "--no-color"]);
  }
  for (const origin of before) {
    if (!expected.has(origin)) execute(["neon-auth", "domain", "delete", origin, "--project-id", project, "--branch", "staging", "--no-color"]);
  }

  const after = listDomains(project, execute);
  if (after.size !== expected.size || [...expected].some((origin) => !after.has(origin))) {
    throw new Error("Neon staging Auth trusted-domain reconciliation did not converge.");
  }
  return { added: [...expected].filter((origin) => !before.has(origin)).length, removed: [...before].filter((origin) => !expected.has(origin)).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = reconcileNeonStagingDomains(process.env);
    console.log(`Reconciled Neon staging Auth trusted domains (added ${result.added}, removed ${result.removed}).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
