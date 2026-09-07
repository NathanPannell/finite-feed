import { readFileSync } from "node:fs";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MARKER_PATTERN = /<!-- finite-feed-release: (\{[^\n]+\}) -->/;

export const REQUIRED_RELEASE_CHECKS = [
  "backend",
  "backend-docker-runtime",
  "frontend",
  "deployment-contracts",
  "deploy-staging",
];

export function normalizeVersion(value) {
  const version = value?.trim();
  if (!VERSION_PATTERN.test(version ?? "")) throw new Error("Release version must use X.Y.Z without a v prefix.");
  return version;
}

export function normalizeSha(value, label = "commit") {
  const sha = value?.trim().toLowerCase();
  if (!SHA_PATTERN.test(sha ?? "")) throw new Error(`${label} must be a full 40-character Git SHA.`);
  return sha;
}

export function readRepositoryVersion(read = readFileSync) {
  return normalizeVersion(read(new URL("../VERSION", import.meta.url), "utf8"));
}

export function releaseTag(version) {
  return `v${normalizeVersion(version)}`;
}

export function releaseMarker({ version, candidate, preparationRun }) {
  const payload = {
    version: normalizeVersion(version),
    candidate: normalizeSha(candidate, "Release candidate"),
    preparationRun: String(preparationRun),
  };
  if (!/^\d+$/.test(payload.preparationRun)) throw new Error("Preparation run must be a GitHub Actions run ID.");
  return `<!-- finite-feed-release: ${JSON.stringify(payload)} -->`;
}

export function parseReleaseMarker(body) {
  const match = body?.match(MARKER_PATTERN);
  if (!match) throw new Error("Release PR is missing its preparation marker.");
  let parsed;
  try { parsed = JSON.parse(match[1]); } catch { throw new Error("Release PR preparation marker is invalid JSON."); }
  return {
    version: normalizeVersion(parsed.version),
    candidate: normalizeSha(parsed.candidate, "Release candidate"),
    preparationRun: String(parsed.preparationRun),
  };
}

export function releasePullRequestBody(metadata) {
  return `${releaseMarker(metadata)}\n\nPromotes the tested staging candidate \`${metadata.candidate}\` as Finite Feed ${releaseTag(metadata.version)}.\n\nThis PR becomes stale and its release check fails if \`staging\` advances. Run **Prepare release** again with the new tested SHA instead of editing this marker.`;
}

export function assertRequiredChecks(checkRuns, required = REQUIRED_RELEASE_CHECKS) {
  const successful = new Set(checkRuns.filter((check) => check.conclusion === "success").map((check) => check.name));
  const missing = required.filter((name) => !successful.has(name));
  if (missing.length) throw new Error(`Release candidate is missing successful checks: ${missing.join(", ")}.`);
}

export function assertReleasePullRequest(event, repositoryVersion) {
  const pull = event.pull_request;
  if (!pull || pull.base?.ref !== "main" || pull.head?.ref !== "staging") {
    throw new Error("A release PR must promote staging directly into main.");
  }
  const marker = parseReleaseMarker(pull.body);
  const head = normalizeSha(pull.head.sha, "Release PR head");
  if (marker.candidate !== head) throw new Error("Staging advanced after preparation; prepare the release again at the new head.");
  if (marker.version !== normalizeVersion(repositoryVersion)) throw new Error("Release PR version does not match VERSION.");
  return marker;
}

export function assertProductionMerge({ expected, checkedOut, parents, currentMain, pullRequests, repositoryVersion }) {
  const deployed = normalizeSha(expected, "Production commit");
  if (normalizeSha(checkedOut, "Checked-out commit") !== deployed) throw new Error("Checked-out commit does not match the requested production commit.");
  if (normalizeSha(currentMain, "Current main commit") !== deployed) throw new Error(`Refusing stale production commit ${deployed}; main is now ${currentMain || "unknown"}.`);
  if (parents.length !== 2) throw new Error("Production requires a two-parent merge commit from the prepared staging PR.");
  const pull = pullRequests.find((candidate) => candidate.merged_at && candidate.base?.ref === "main" && candidate.head?.ref === "staging" && candidate.merge_commit_sha === deployed);
  if (!pull) throw new Error("Production commit is not the merge commit of a staging-to-main release PR.");
  const marker = parseReleaseMarker(pull.body);
  if (normalizeSha(parents[1], "Merged staging commit") !== marker.candidate) throw new Error("Production merge does not contain the prepared staging candidate as its second parent.");
  if (marker.version !== normalizeVersion(repositoryVersion)) throw new Error("Production release marker does not match VERSION.");
  return marker;
}

export function assertPreparationRun(run, marker, { allowInProgress = false } = {}) {
  if (run.event !== "workflow_dispatch" || run.head_branch !== "staging" || run.head_sha !== marker.candidate || run.path !== ".github/workflows/release.yml") {
    throw new Error("Release marker does not identify a preparation run for this staging candidate.");
  }
  if (run.status === "completed" && run.conclusion === "success") return;
  if (allowInProgress && (run.status === "queued" || run.status === "in_progress")) return;
  throw new Error("Release preparation run has not completed successfully.");
}

export async function githubJson(path, { token, repository, method = "GET", body, fetchImpl = fetch, allowMissing = false } = {}) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (allowMissing && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub API request failed (${method} ${path}, HTTP ${response.status}).`);
  return response.status === 204 ? undefined : response.json();
}

export async function resolveTagCommit(tag, context) {
  const reference = await githubJson(`/git/ref/tags/${encodeURIComponent(tag)}`, { ...context, allowMissing: true });
  if (!reference) return undefined;
  let object = reference.object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth += 1) {
    object = await githubJson(`/git/tags/${object.sha}`, context).then((annotated) => annotated.object);
  }
  if (object?.type !== "commit") throw new Error(`Tag ${tag} does not resolve to a commit.`);
  return normalizeSha(object.sha, `Tag ${tag}`);
}
