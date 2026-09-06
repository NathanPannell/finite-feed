import assert from "node:assert/strict";
import test from "node:test";
import { configureVariables, variablePlans } from "./set-railway-variables.mjs";

const environment = {
  NEON_AUTH_BASE_URL: "https://preview.neonauth.example/app/auth",
  RAILWAY_PROJECT_ID: "project", RAILWAY_API_SERVICE_ID: "api", RAILWAY_WORKER_SERVICE_ID: "worker",
  EXPECTED_COMMIT_SHA: "commit", YOUTUBE_API_KEY: "youtube-secret", MATCH_LAB_COOKIE_SECRET: "cookie-secret",
  TELEGRAM_PRODUCTION_BOT_TOKEN: "production-secret", TELEGRAM_DEVELOPER_BOT_TOKEN: "developer-secret",
  VERCEL_OIDC_TEAM_SLUG: "team", VERCEL_OIDC_PROJECT_NAME: "frontend", PREVIEW_ENVIRONMENT: "pr-21",
  GITHUB_REPOSITORY: "owner/repository", PREVIEW_PULL_REQUEST: "21",
  PREVIEW_DATABASE_URL: "postgresql://preview-pool/db", PREVIEW_DATABASE_URL_UNPOOLED: "postgresql://preview-direct/db",
};

test("production batches exact service settings and preserves optional deletion", () => {
  const calls = [];
  const plans = variablePlans("production", { ...environment, TELEGRAM_DEVELOPER_BOT_TOKEN: "", OPENROUTER_API_KEY: "a=b c\n$d", MATCH_LAB_DEBUG_ASSESSMENT: "true" });
  configureVariables(plans, (args) => {
    calls.push(args);
    return args[1] === "list" ? (calls.filter((call) => call[1] === "list").length <= 2 ? JSON.stringify({ TELEGRAM_DEVELOPER_BOT_TOKEN: null, UNRELATED_SECRET: "untouched" }) : JSON.stringify({ UNRELATED_SECRET: "untouched" })) : "";
  });
  assert.equal(calls.filter((args) => args[1] === "list").length, 4);
  const writes = calls.filter((args) => args[1] === "set");
  assert.equal(writes.length, 2);
  for (const args of writes) {
    assert.ok(args.includes("--skip-deploys"));
    assert.ok(args.includes("OPENROUTER_API_KEY=a=b c\n$d"));
    assert.ok(args.includes("TELEGRAM_PRODUCTION_BOT_TOKEN=production-secret"));
    assert.equal(args[args.indexOf("--environment") + 1], "production");
    assert.equal(args[args.indexOf("--project") + 1], "project");
  }
  assert.ok(writes[0].includes("MATCH_LAB_DEBUG_ASSESSMENT=false"));
  assert.ok(writes[0].includes("MATCH_LAB_COOKIE_SECRET=cookie-secret"));
  assert.ok(!writes[1].some((arg) => arg.startsWith("MATCH_LAB_COOKIE_SECRET=")));
  assert.deepEqual(calls.filter((args) => args[1] === "delete").map((args) => args[2]), ["TELEGRAM_DEVELOPER_BOT_TOKEN", "TELEGRAM_DEVELOPER_BOT_TOKEN"]);
});

test("preview isolates database, strips production token and configures signing", () => {
  const calls = [];
  const plans = variablePlans("preview", { ...environment, MATCH_LAB_DEBUG_ASSESSMENT: "true" });
  configureVariables(plans, (args) => {
    calls.push(args);
    if (args[1] !== "list") return "";
    return calls.filter((call) => call[1] === "list").length <= 2
      ? '{"TELEGRAM_PRODUCTION_BOT_TOKEN":null,"DATABASE_URL":null,"DATABASE_URL_UNPOOLED":null,"PREVIEW_DATABASE_URL_UNPOOLED":null,"MATCH_LAB_COOKIE_SECRET":null}'
      : '{}';
  });
  for (const plan of plans) {
    assert.equal(plan.target, "pr-21");
    assert.equal(plan.values.PREVIEW_DATABASE_URL, environment.PREVIEW_DATABASE_URL);
    assert.equal(plan.values.TELEGRAM_PRODUCTION_BOT_TOKEN, undefined);
    assert.equal(plan.values.TELEGRAM_DEVELOPER_BOT_TOKEN, "developer-secret");
    assert.equal(plan.values.PREVIEW_OWNER_REPOSITORY, "owner/repository");
    assert.equal(plan.values.PREVIEW_PULL_REQUEST, "21");
  }
  assert.equal(plans[0].values.PREVIEW_DATABASE_URL_UNPOOLED, environment.PREVIEW_DATABASE_URL_UNPOOLED);
  assert.equal(plans[1].values.PREVIEW_DATABASE_URL_UNPOOLED, undefined);
  assert.equal(plans[0].values.MATCH_LAB_TARGET_ENVIRONMENT, "pr-21");
  assert.equal(plans[0].values.VERCEL_OIDC_ENVIRONMENT, "preview");
  assert.equal(plans[0].values.MATCH_LAB_DEBUG_ASSESSMENT, "true");
  assert.equal(calls.filter((args) => args[1] === "set").length, 2);
  assert.equal(calls.filter((args) => args[1] === "delete" && args[2] === "TELEGRAM_PRODUCTION_BOT_TOKEN").length, 2);
  assert.equal(calls.filter((args) => args[1] === "delete" && args[2] === "DATABASE_URL").length, 2);
  assert.equal(calls.filter((args) => args[1] === "delete" && args[2] === "DATABASE_URL_UNPOOLED").length, 2);
  assert.equal(calls.filter((args) => args[1] === "delete" && args[2] === "PREVIEW_DATABASE_URL_UNPOOLED").length, 1);
  assert.equal(calls.filter((args) => args[1] === "delete" && args[2] === "MATCH_LAB_COOKIE_SECRET").length, 1);
  for (const service of ["api", "worker"]) {
    const serviceCalls = calls.filter((args) => args.includes(service));
    assert.ok(serviceCalls.findIndex((args) => args[1] === "set") < serviceCalls.findIndex((args) => args[1] === "delete"));
  }
});

test("rejects unsafe targets and incomplete configuration before executing", () => {
  for (const key of ["RAILWAY_PROJECT_ID", "RAILWAY_API_SERVICE_ID", "RAILWAY_WORKER_SERVICE_ID", "YOUTUBE_API_KEY", "MATCH_LAB_COOKIE_SECRET", "TELEGRAM_DEVELOPER_BOT_TOKEN", "PREVIEW_DATABASE_URL", "PREVIEW_DATABASE_URL_UNPOOLED", "GITHUB_REPOSITORY", "PREVIEW_PULL_REQUEST"]) {
    assert.throws(() => variablePlans("preview", { ...environment, [key]: "" }), /Missing required variable/);
  }
  assert.throws(() => variablePlans("preview", { ...environment, PREVIEW_ENVIRONMENT: "production" }), /Preview target/);
  assert.throws(() => variablePlans("preview", { ...environment, PREVIEW_PULL_REQUEST: "22" }), /PR tag/);
  assert.throws(() => variablePlans("production", { ...environment, TELEGRAM_PRODUCTION_BOT_TOKEN: "" }), /Missing required/);
});

test("a failed or malformed listing cannot erase or update variables", () => {
  for (const response of ["not JSON", "null", "[]"]) {
    const calls = [];
    assert.throws(() => configureVariables(variablePlans("production", environment), (args) => { calls.push(args); return response; }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], "list");
  }
  assert.throws(() => configureVariables(variablePlans("production", environment), () => { throw new Error("sensitive upstream response"); }), /Could not read API variable names/);
});

test("verification fails safely when a forbidden preview variable survives deletion", () => {
  const calls = [];
  assert.throws(
    () => configureVariables(variablePlans("preview", environment), (args) => {
      calls.push(args);
      return args[1] === "list" ? '{"DATABASE_URL":"secret-value-never-printed"}' : "";
    }),
    /API variable isolation failed for: DATABASE_URL/,
  );
  assert.equal(calls.filter((args) => args[1] === "set").length, 2);
  assert.ok(!calls.flat().includes("secret-value-never-printed"));
});
