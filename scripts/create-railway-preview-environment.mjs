import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const THROTTLE_PATTERN = /1 environment[^\n]*30 seconds/i;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_DELAY_MS = 32_000;

function required(environment, key) {
  const value = environment[key];
  if (!value) throw new Error(`Missing required variable: ${key}`);
  return value;
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

function failureDetails(error) {
  return [error?.details, error?.stderr, error?.stdout, error?.message]
    .filter(Boolean)
    .map(String)
    .join("\n");
}

export function isEnvironmentCreationThrottle(error) {
  return THROTTLE_PATTERN.test(failureDetails(error));
}

export function previewEnvironmentCreateArgs(environment) {
  const name = required(environment, "PREVIEW_ENVIRONMENT");
  const pullRequest = required(environment, "PREVIEW_PULL_REQUEST");
  if (name !== `pr-${pullRequest}`) throw new Error("Preview environment must match the pull request number.");
  const project = required(environment, "RAILWAY_PROJECT_ID");
  const base = required(environment, "RAILWAY_BASE_ENVIRONMENT_ID");
  const api = required(environment, "RAILWAY_API_SERVICE_ID");
  const worker = required(environment, "RAILWAY_WORKER_SERVICE_ID");
  const pooled = required(environment, "PREVIEW_DATABASE_URL");
  const unpooled = required(environment, "PREVIEW_DATABASE_URL_UNPOOLED");
  void project;
  return [
    "environment", "new", name,
    "--copy", base,
    "--service-config", api, "variables.DATABASE_URL.value", pooled,
    "--service-config", api, "variables.DATABASE_URL_UNPOOLED.value", unpooled,
    "--service-config", api, "variables.PREVIEW_DATABASE_URL.value", pooled,
    "--service-config", api, "variables.PREVIEW_DATABASE_URL_UNPOOLED.value", unpooled,
    "--service-config", api, "variables.DELIVERY_ENABLED.value", "false",
    "--service-config", api, "variables.TELEGRAM_PRODUCTION_BOT_TOKEN.value", "disabled-in-preview",
    "--service-config", api, "variables.TELEGRAM_PRODUCTION_CHAT_ID.value", "disabled-in-preview",
    "--service-config", worker, "variables.DATABASE_URL.value", pooled,
    "--service-config", worker, "variables.DATABASE_URL_UNPOOLED.value", unpooled,
    "--service-config", worker, "variables.PREVIEW_DATABASE_URL.value", pooled,
    "--service-config", worker, "variables.DELIVERY_ENABLED.value", "false",
    "--service-config", worker, "variables.TELEGRAM_PRODUCTION_BOT_TOKEN.value", "disabled-in-preview",
    "--service-config", worker, "variables.TELEGRAM_PRODUCTION_CHAT_ID.value", "disabled-in-preview",
  ];
}

export function railwayCommand(args) {
  try {
    return execFileSync("railway", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (error) {
    const failure = new Error("Railway command failed.");
    failure.details = failureDetails(error);
    throw failure;
  }
}

async function environmentExists(environment, execute) {
  let raw;
  try {
    raw = await execute(["environment", "list", "--json"]);
  } catch {
    throw new Error("Could not list Railway preview environments.");
  }
  let listing;
  try {
    listing = JSON.parse(raw);
  } catch {
    throw new Error("Railway preview environment listing returned invalid JSON.");
  }
  return findNames(listing).has(required(environment, "PREVIEW_ENVIRONMENT"));
}

export async function ensureRailwayPreviewEnvironment(environment, dependencies = {}) {
  const execute = dependencies.execute ?? railwayCommand;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const log = dependencies.log ?? console.log;
  const maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = dependencies.baseDelayMs ?? DEFAULT_DELAY_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer.");
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 30_001) throw new Error("baseDelayMs must exceed Railway's 30-second limit.");

  const project = required(environment, "RAILWAY_PROJECT_ID");
  const base = required(environment, "RAILWAY_BASE_ENVIRONMENT_ID");
  const pullRequest = required(environment, "PREVIEW_PULL_REQUEST");
  if (!/^[1-9][0-9]*$/.test(pullRequest)) throw new Error("PREVIEW_PULL_REQUEST must be a positive integer.");
  const createArgs = previewEnvironmentCreateArgs(environment);
  await execute(["link", "--project", project, "--environment", base]);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await environmentExists(environment, execute)) {
      log("Railway preview environment already exists; updating it in place.");
      return { created: false, attempts: attempt - 1 };
    }
    try {
      await execute(createArgs);
      return { created: true, attempts: attempt };
    } catch (error) {
      if (await environmentExists(environment, execute)) {
        log("Railway preview environment appeared after an ambiguous create response.");
        return { created: true, attempts: attempt };
      }
      if (!isEnvironmentCreationThrottle(error)) {
        throw new Error("Railway preview environment creation failed without a retryable quota response.");
      }
      if (attempt === maxAttempts) {
        throw new Error(`Railway preview environment creation remained throttled after ${maxAttempts} attempts.`);
      }
      const jitterMs = (Number(pullRequest) * 997) % 7_000;
      const delayMs = baseDelayMs + jitterMs;
      log(`Railway environment creation is throttled; retrying attempt ${attempt + 1} of ${maxAttempts} after ${Math.ceil(delayMs / 1000)} seconds.`);
      await sleep(delayMs);
    }
  }
  throw new Error("Railway preview environment creation exhausted its retry budget.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await ensureRailwayPreviewEnvironment(process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
