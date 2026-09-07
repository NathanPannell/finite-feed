import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isEnvironmentCreationThrottle } from "./create-railway-preview-environment.mjs";

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_DELAY_MS = 32_000;

function required(environment, key) {
  const value = environment[key];
  if (!value) throw new Error(`Missing required variable: ${key}`);
  return value;
}

function findNames(value, names = new Set()) {
  if (Array.isArray(value)) for (const item of value) findNames(item, names);
  else if (value && typeof value === "object") {
    if (typeof value.name === "string") names.add(value.name);
    for (const item of Object.values(value)) findNames(item, names);
  }
  return names;
}

export function stagingEnvironmentCreateArgs(environment) {
  if (required(environment, "RAILWAY_ENVIRONMENT") !== "staging") throw new Error("Railway staging environment must be named staging.");
  const base = required(environment, "RAILWAY_BASE_ENVIRONMENT_ID");
  const api = required(environment, "RAILWAY_API_SERVICE_ID");
  const worker = required(environment, "RAILWAY_WORKER_SERVICE_ID");
  const pooled = required(environment, "STAGING_DATABASE_URL");
  const direct = required(environment, "STAGING_DATABASE_URL_UNPOOLED");
  return [
    "environment", "new", "staging", "--copy", base,
    "--service-config", api, "variables.DATABASE_URL.value", pooled,
    "--service-config", api, "variables.DATABASE_URL_UNPOOLED.value", direct,
    "--service-config", api, "variables.DELIVERY_ENABLED.value", "false",
    "--service-config", api, "variables.PUBLIC_APP_URL.value", "https://staging.invalid",
    "--service-config", api, "variables.TELEGRAM_PRODUCTION_BOT_TOKEN.value", "disabled-in-staging",
    "--service-config", api, "variables.TELEGRAM_PRODUCTION_CHAT_ID.value", "disabled-in-staging",
    "--service-config", worker, "variables.DATABASE_URL.value", pooled,
    "--service-config", worker, "variables.DELIVERY_ENABLED.value", "false",
    "--service-config", worker, "variables.PUBLIC_APP_URL.value", "https://staging.invalid",
    "--service-config", worker, "variables.TELEGRAM_PRODUCTION_BOT_TOKEN.value", "disabled-in-staging",
    "--service-config", worker, "variables.TELEGRAM_PRODUCTION_CHAT_ID.value", "disabled-in-staging",
  ];
}

function railway(args) {
  try {
    return execFileSync("railway", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, windowsHide: true });
  } catch (error) {
    const failure = new Error("Railway staging environment command failed.");
    failure.details = [error?.stderr, error?.stdout, error?.message].filter(Boolean).map(String).join("\n");
    throw failure;
  }
}

async function environmentExists(project, execute) {
  let raw;
  try {
    raw = await execute(["environment", "list", "--json"]);
  } catch {
    throw new Error("Could not list Railway environments.");
  }
  let listing;
  try {
    listing = JSON.parse(raw);
  } catch {
    throw new Error("Railway environment listing returned invalid JSON.");
  }
  void project;
  return findNames(listing).has("staging");
}

export async function ensureRailwayStagingEnvironment(environment, dependencies = {}) {
  const execute = dependencies.execute ?? railway;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = dependencies.delayMs ?? DEFAULT_DELAY_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer.");
  if (!Number.isInteger(delayMs) || delayMs < 30_001) throw new Error("delayMs must exceed Railway's 30-second limit.");
  const project = required(environment, "RAILWAY_PROJECT_ID");
  const base = required(environment, "RAILWAY_BASE_ENVIRONMENT_ID");
  await execute(["link", "--project", project, "--environment", base]);
  if (await environmentExists(project, execute)) return { created: false, attempts: 0 };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await execute(stagingEnvironmentCreateArgs(environment));
      return { created: true, attempts: attempt };
    } catch (error) {
      if (await environmentExists(project, execute)) return { created: true, attempts: attempt };
      if (!isEnvironmentCreationThrottle(error)) throw new Error("Could not create the isolated Railway staging environment.");
      if (attempt === maxAttempts) throw new Error(`Railway staging environment creation remained throttled after ${maxAttempts} attempts.`);
      await sleep(delayMs);
    }
  }
  throw new Error("Railway staging environment creation exhausted its retry budget.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await ensureRailwayStagingEnvironment(process.env);
    console.log(result.created ? "Created isolated Railway staging environment." : "Reusing isolated Railway staging environment.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
