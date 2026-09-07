import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// CLI v5.47.2 batches KEY=VALUE arguments into one VariableCollectionUpsert:
// https://github.com/railwayapp/cli/blob/v5.47.2/src/commands/variable.rs
function required(environment, key) {
  if (!environment[key]) throw new Error(`Missing required variable: ${key}`);
  return environment[key];
}

export function variablePlans(mode, environment) {
  if (!["production", "preview"].includes(mode)) throw new Error("Expected production or preview mode");
  const target = mode === "production" ? "production" : required(environment, "PREVIEW_ENVIRONMENT");
  if (mode === "preview" && !/^pr-[1-9][0-9]*$/.test(target)) throw new Error("Preview target must be a PR environment");
  const project = required(environment, "RAILWAY_PROJECT_ID");
  const api = required(environment, "RAILWAY_API_SERVICE_ID");
  const worker = required(environment, "RAILWAY_WORKER_SERVICE_ID");
  if (api === worker) throw new Error("API and worker must be distinct services");
  const common = {
    APP_COMMIT_SHA: required(environment, "EXPECTED_COMMIT_SHA"),
    YOUTUBE_API_KEY: required(environment, "YOUTUBE_API_KEY"),
    OPENROUTER_MODEL: environment.OPENROUTER_MODEL || "google/gemma-4-31b-it:free",
    EMBEDDING_MODEL: environment.EMBEDDING_MODEL || "Snowflake/snowflake-arctic-embed-xs",
    EMBEDDING_MODEL_REVISION: environment.EMBEDDING_MODEL_REVISION || "d8c86521100d3556476a063fc2342036d45c106f",
    EMBEDDING_BATCH_SIZE: environment.EMBEDDING_BATCH_SIZE || "32",
    EMBEDDING_DIMENSIONS: "384",
    EMBEDDING_OFFLINE: "true",
    EMBEDDING_CACHE_DIR: "/opt/huggingface",
    DELIVERY_ENABLED: mode === "preview" ? "false" : environment.DELIVERY_ENABLED || "true",
    MODEL_DAILY_REQUEST_LIMIT: environment.MODEL_DAILY_REQUEST_LIMIT || "40",
    YOUTUBE_DAILY_REQUEST_LIMIT: environment.YOUTUBE_DAILY_REQUEST_LIMIT || "1000",
  };
  if (mode === "preview") {
    common.PREVIEW_OWNER_REPOSITORY = required(environment, "GITHUB_REPOSITORY");
    common.PREVIEW_PULL_REQUEST = required(environment, "PREVIEW_PULL_REQUEST");
    if (!/^[1-9][0-9]*$/.test(common.PREVIEW_PULL_REQUEST) || target !== `pr-${common.PREVIEW_PULL_REQUEST}`) {
      throw new Error("Preview PR tag must match the Railway environment");
    }
  }
  const optional = ["OPENROUTER_API_KEY", "TELEGRAM_WEBHOOK_SECRET", "DEVELOPER_TELEGRAM_USER_IDS"];
  const remove = [];
  if (mode === "production") {
    common.TELEGRAM_PRODUCTION_BOT_TOKEN = required(environment, "TELEGRAM_PRODUCTION_BOT_TOKEN");
    optional.push("TELEGRAM_DEVELOPER_BOT_TOKEN", "TELEGRAM_PRODUCTION_CHAT_ID");
  } else {
    common.PREVIEW_DATABASE_URL = required(environment, "PREVIEW_DATABASE_URL");
    common.TELEGRAM_DEVELOPER_BOT_TOKEN = required(environment, "TELEGRAM_DEVELOPER_BOT_TOKEN");
    remove.push("TELEGRAM_PRODUCTION_BOT_TOKEN", "TELEGRAM_PRODUCTION_CHAT_ID");
  }
  for (const key of optional) {
    if (environment[key]) common[key] = environment[key];
    else remove.push(key);
  }
  const apiOnly = {
    NEON_AUTH_BASE_URL: required(environment, "NEON_AUTH_BASE_URL"),
    VERCEL_OIDC_TEAM_SLUG: required(environment, "VERCEL_OIDC_TEAM_SLUG"),
    VERCEL_OIDC_PROJECT_NAME: required(environment, "VERCEL_OIDC_PROJECT_NAME"),
    VERCEL_OIDC_ENVIRONMENT: mode,
    MATCH_LAB_COOKIE_SECRET: required(environment, "MATCH_LAB_COOKIE_SECRET"),
    MATCH_LAB_DEBUG_ASSESSMENT: mode === "preview" ? environment.MATCH_LAB_DEBUG_ASSESSMENT || "false" : "false",
    MATCH_LAB_TARGET_ENVIRONMENT: target,
  };
  if (mode === "preview") apiOnly.PREVIEW_DATABASE_URL_UNPOOLED = required(environment, "PREVIEW_DATABASE_URL_UNPOOLED");
  const apiRemove = [...remove];
  const workerRemove = [...remove];
  if (mode === "preview") {
    apiRemove.push("DATABASE_URL", "DATABASE_URL_UNPOOLED");
    workerRemove.push(
      "DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
      "PREVIEW_DATABASE_URL_UNPOOLED",
      "MATCH_LAB_COOKIE_SECRET",
    );
  }
  return [
    { role: "API", service: api, project, target, values: { ...common, ...apiOnly }, remove: apiRemove },
    { role: "worker", service: worker, project, target, values: { ...common }, remove: workerRemove },
  ];
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function variableNames(plan, scope, execute, operation) {
  let parsed;
  try {
    parsed = JSON.parse(execute(["variable", "list", "--json", ...scope]));
  } catch {
    throw new Error(`Could not ${operation} ${plan.role} variable names`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Railway variable listing");
  return new Set(Object.keys(parsed));
}

export function configureVariables(plans, execute, { sleep = wait, delayMs = 2000, maxAttempts = 10 } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 3) throw new Error("Variable verification requires at least three attempts");
  const inventories = [];
  for (const plan of plans) {
    const scope = ["--service", plan.service, "--environment", plan.target, "--project", plan.project];
    // Preflight every service before mutating either one. Raw listings remain in
    // memory because Railway JSON can include secret values and sealed keys.
    variableNames(plan, scope, execute, "read");
    inventories.push({ plan, scope });
  }
  // Apply all safe preview values before any delete can trigger a deployment.
  for (const { plan, scope } of inventories) {
    execute(["variable", "set", ...Object.entries(plan.values).map(([key, value]) => `${key}=${value}`), "--skip-deploys", ...scope]);
  }
  const failures = [];
  for (const { plan, scope } of inventories) {
    try {
      const requiredCleanReads = plan.target === "production" ? 1 : 3;
      let cleanReads = 0;
      let forbidden = [];
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const names = variableNames(plan, scope, execute, "verify");
        forbidden = plan.remove.filter((key) => names.has(key));
        if (forbidden.length) {
          cleanReads = 0;
          for (const key of forbidden) execute(["variable", "delete", key, ...scope]);
        } else {
          cleanReads += 1;
          if (cleanReads === requiredCleanReads) break;
        }
        if (attempt + 1 < maxAttempts) sleep(delayMs);
      }
      if (forbidden.length || cleanReads < requiredCleanReads) {
        const detail = forbidden.length ? ` for: ${forbidden.join(", ")}` : " before the verification timeout";
        failures.push(`${plan.role} variable isolation failed${detail}`);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `${plan.role} variable isolation failed`);
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
}

function railway(args) {
  // Use argument arrays, never shell interpolation or inherited command output.
  // CLI failures can include request details; expose only a sanitized operation name.
  const result = spawnSync("railway", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error(`Railway variable ${args[1]} failed`);
  return result.stdout;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    configureVariables(variablePlans(process.argv[2], process.env), railway);
    console.log("Configured API and worker variables with one batch write per service.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
