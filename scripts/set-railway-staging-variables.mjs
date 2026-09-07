import { pathToFileURL } from "node:url";
import { configureVariables } from "./set-railway-variables.mjs";

function required(environment, key) {
  if (!environment[key]) throw new Error(`Missing required variable: ${key}`);
  return environment[key];
}

export function stagingVariablePlans(environment) {
  if (required(environment, "RAILWAY_ENVIRONMENT") !== "staging") throw new Error("Railway staging environment must be named staging.");
  const project = required(environment, "RAILWAY_PROJECT_ID");
  const api = required(environment, "RAILWAY_API_SERVICE_ID");
  const worker = required(environment, "RAILWAY_WORKER_SERVICE_ID");
  if (api === worker) throw new Error("API and worker must be distinct services.");
  const common = {
    DATABASE_URL: required(environment, "STAGING_DATABASE_URL"),
    APP_COMMIT_SHA: required(environment, "EXPECTED_COMMIT_SHA"),
    YOUTUBE_API_KEY: required(environment, "YOUTUBE_API_KEY"),
    OPENROUTER_MODEL: environment.OPENROUTER_MODEL || "google/gemma-4-31b-it:free",
    EMBEDDING_MODEL: environment.EMBEDDING_MODEL || "Snowflake/snowflake-arctic-embed-xs",
    EMBEDDING_MODEL_REVISION: environment.EMBEDDING_MODEL_REVISION || "d8c86521100d3556476a063fc2342036d45c106f",
    EMBEDDING_BATCH_SIZE: environment.EMBEDDING_BATCH_SIZE || "32",
    EMBEDDING_DIMENSIONS: "384",
    EMBEDDING_OFFLINE: "true",
    EMBEDDING_CACHE_DIR: "/opt/huggingface",
    DELIVERY_ENABLED: "false",
    PUBLIC_APP_URL: "https://staging.invalid",
    MODEL_DAILY_REQUEST_LIMIT: environment.MODEL_DAILY_REQUEST_LIMIT || "40",
    YOUTUBE_DAILY_REQUEST_LIMIT: environment.YOUTUBE_DAILY_REQUEST_LIMIT || "1000",
  };
  for (const key of ["OPENROUTER_API_KEY", "TELEGRAM_DEVELOPER_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "DEVELOPER_TELEGRAM_USER_IDS"]) {
    if (environment[key]) common[key] = environment[key];
  }
  const remove = [
    "PREVIEW_DATABASE_URL", "PREVIEW_DATABASE_URL_UNPOOLED",
    "TELEGRAM_PRODUCTION_BOT_TOKEN", "TELEGRAM_PRODUCTION_CHAT_ID",
  ];
  const apiOnly = {
    DATABASE_URL_UNPOOLED: required(environment, "STAGING_DATABASE_URL_UNPOOLED"),
    NEON_AUTH_BASE_URL: required(environment, "NEON_AUTH_BASE_URL"),
    VERCEL_OIDC_TEAM_SLUG: required(environment, "VERCEL_OIDC_TEAM_SLUG"),
    VERCEL_OIDC_PROJECT_NAME: required(environment, "VERCEL_OIDC_PROJECT_NAME"),
    VERCEL_OIDC_ENVIRONMENT: "preview",
    MATCH_LAB_COOKIE_SECRET: required(environment, "MATCH_LAB_COOKIE_SECRET"),
    MATCH_LAB_DEBUG_ASSESSMENT: environment.MATCH_LAB_DEBUG_ASSESSMENT || "false",
    MATCH_LAB_TARGET_ENVIRONMENT: "staging",
  };
  const optional = ["OPENROUTER_API_KEY", "TELEGRAM_DEVELOPER_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "DEVELOPER_TELEGRAM_USER_IDS"];
  for (const key of optional) if (!environment[key]) remove.push(key);
  return [
    { role: "API", service: api, project, target: "staging", values: { ...common, ...apiOnly }, remove },
    { role: "worker", service: worker, project, target: "staging", values: common, remove: [
      ...remove, "DATABASE_URL_UNPOOLED", "MATCH_LAB_COOKIE_SECRET", "MATCH_LAB_DEBUG_ASSESSMENT",
      "MATCH_LAB_TARGET_ENVIRONMENT", "NEON_AUTH_BASE_URL", "VERCEL_OIDC_TEAM_SLUG",
      "VERCEL_OIDC_PROJECT_NAME", "VERCEL_OIDC_ENVIRONMENT",
    ] },
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { spawnSync } = await import("node:child_process");
    const railway = (args) => {
      const result = spawnSync("railway", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (result.error || result.status !== 0) throw new Error(`Railway variable ${args[1]} failed`);
      return result.stdout;
    };
    configureVariables(stagingVariablePlans(process.env), railway);
    console.log("Configured isolated staging variables for API and worker.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
