import { defineRailway, github, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const repository = github("NathanPannell/finite-feed");

  const worker = service("worker", {
    source: repository,
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "backend/Dockerfile.worker",
      watchPatterns: ["backend/**", "database/**"],
    },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: {
      DATABASE_URL: preserve(),
      APP_COMMIT_SHA: preserve(),
      YOUTUBE_API_KEY: preserve(),
      OPENROUTER_API_KEY: preserve(),
      OPENROUTER_MODEL: preserve(),
      TELEGRAM_PRODUCTION_BOT_TOKEN: preserve(),
      TELEGRAM_DEVELOPER_BOT_TOKEN: preserve(),
      TELEGRAM_WEBHOOK_SECRET: preserve(),
      TELEGRAM_PRODUCTION_CHAT_ID: preserve(),
      DEVELOPER_TELEGRAM_USER_IDS: preserve(),
      PUBLIC_APP_URL: preserve(),
    },
    replicas: { "us-west2": 1 },
  });

  const api = service("api", {
    source: repository,
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "backend/Dockerfile.api",
      watchPatterns: ["backend/**", "database/**"],
    },
    deploy: {
      preDeployCommand: ["python -m backend.app.migrate"],
      healthcheckPath: "/health",
      healthcheckTimeout: 60,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 3,
    },
    env: {
      DATABASE_URL: preserve(),
      DATABASE_URL_UNPOOLED: preserve(),
      FRONTEND_ORIGINS: preserve(),
      APP_COMMIT_SHA: preserve(),
      YOUTUBE_API_KEY: preserve(),
      OPENROUTER_API_KEY: preserve(),
      OPENROUTER_MODEL: preserve(),
      TELEGRAM_PRODUCTION_BOT_TOKEN: preserve(),
      TELEGRAM_DEVELOPER_BOT_TOKEN: preserve(),
      TELEGRAM_WEBHOOK_SECRET: preserve(),
      TELEGRAM_PRODUCTION_CHAT_ID: preserve(),
      DEVELOPER_TELEGRAM_USER_IDS: preserve(),
      PUBLIC_APP_URL: preserve(),
      MATCH_LAB_COOKIE_SECRET: preserve(),
      MATCH_LAB_DEBUG_ASSESSMENT: preserve(),
      MATCH_LAB_TARGET_ENVIRONMENT: preserve(),
    },
    replicas: { "us-west2": 1 },
  });

  return project("finite-feed", {
    resources: [worker, api],
  });
});
