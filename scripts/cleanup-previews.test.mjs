import assert from "node:assert/strict";
import test from "node:test";
import { cleanupPreviews, cleanupVercel, previewTargets, railwayCommand } from "./cleanup-previews.mjs";

const environment = {
  PREVIEW_PULL_REQUEST: "21",
  GITHUB_REPOSITORY: "owner/repository",
  RAILWAY_PROJECT_ID: "railway-project",
  RAILWAY_BASE_ENVIRONMENT_ID: "production-id",
  NEON_PROJECT_ID: "neon-project",
  NEON_API_KEY: "neon-secret",
  VERCEL_PROJECT_ID: "vercel-project",
  VERCEL_ORG_ID: "team-id",
  VERCEL_TOKEN: "vercel-secret",
};

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("rejects cleanup targets outside the strict PR boundary", () => {
  for (const value of ["0", "-1", "21x", "production", "21 ../22", ""]) {
    assert.throws(() => previewTargets({ PREVIEW_PULL_REQUEST: value }), /positive PR|Missing required/);
  }
  assert.deepEqual([...previewTargets({ PREVIEW_PULL_REQUEST: "21,21,22" })], ["21", "22"]);
});

test("Vercel pagination removes every exactly tagged deployment and nothing else", async () => {
  const calls = [];
  const pages = [
    { deployments: [
      { uid: "dpl_matchOne", projectId: "vercel-project", target: "preview", meta: { previewRepository: "owner/repository", previewPullRequest: "21" } },
      { uid: "dpl_wrongRepo", projectId: "vercel-project", target: "preview", meta: { previewRepository: "other/repository", previewPullRequest: "21" } },
      { uid: "dpl_production", projectId: "vercel-project", target: "production", meta: { previewRepository: "owner/repository", previewPullRequest: "21" } },
    ], pagination: { next: 123 } },
    { deployments: [
      { uid: "dpl_matchTwo", projectId: "vercel-project", target: "preview", meta: { previewRepository: "owner/repository", previewPullRequest: "21" } },
      { uid: "dpl_openPr", projectId: "vercel-project", target: "preview", meta: { previewRepository: "owner/repository", previewPullRequest: "22" } },
    ], pagination: {} },
  ];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    assert.ok(options.signal instanceof AbortSignal);
    if (options.method === "DELETE") return json({}, 204);
    return json(pages.shift());
  };
  assert.equal(await cleanupVercel({ environment, targets: new Set(["21"]), fetchImpl }), 2);
  const deletes = calls.filter((call) => call.options.method === "DELETE").map((call) => new URL(call.url).pathname);
  assert.deepEqual(deletes, ["/v13/deployments/dpl_matchOne", "/v13/deployments/dpl_matchTwo"]);
  assert.equal(new URL(calls.filter((call) => !call.options.method)[1].url).searchParams.get("until"), "123");
});

test("a recorded legacy deployment is removed only when project-scoped preview listing confirms it", async () => {
  const deletes = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "DELETE") {
      deletes.push(new URL(url).pathname);
      return json({}, 204);
    }
    return json({ deployments: [
      { uid: "dpl_legacySafe", projectId: "vercel-project", target: null, meta: {} },
      { uid: "dpl_otherProject", projectId: "other-project", target: null, meta: {} },
      { uid: "dpl_production", projectId: "vercel-project", target: "production", meta: {} },
      { uid: "dpl_wrongPr", projectId: "vercel-project", target: null, meta: { previewRepository: "owner/repository", previewPullRequest: "22" } },
    ], pagination: {} });
  };
  const configured = { ...environment, VERCEL_LEGACY_DEPLOYMENT_IDS: "dpl_legacySafe,dpl_otherProject,dpl_production,dpl_wrongPr,dpl_absent" };
  assert.equal(await cleanupVercel({ environment: configured, targets: new Set(["21"]), fetchImpl }), 1);
  assert.deepEqual(deletes, ["/v13/deployments/dpl_legacySafe"]);
});

test("cleanup is idempotent when all provider resources are absent", async () => {
  const execute = (args) => args[0] === "environment" && args[1] === "list" ? '{"environments":[{"name":"production"}]}' : "";
  const fetchImpl = async (url) => String(url).includes("api.vercel.com")
    ? json({ deployments: [], pagination: {} })
    : json({ branches: [], pagination: {} });
  assert.deepEqual(await cleanupPreviews({ environment, execute, fetchImpl }), { railway: 0, neon: 0, vercel: 0 });
});

test("all providers and matching resources are attempted before failures are reported", async () => {
  const commands = [];
  const deletes = [];
  const execute = (args) => {
    commands.push(args);
    if (args[0] === "environment" && args[1] === "list") return '{"environments":[{"name":"pr-21"},{"name":"production"}]}' ;
    if (args[0] === "environment" && args[1] === "delete") throw new Error("sensitive Railway failure");
    return "";
  };
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (options.method === "DELETE") {
      deletes.push(value);
      if (value.includes("dpl_fail")) return json({}, 500);
      return json({}, 204);
    }
    if (value.includes("api.vercel.com")) return json({ deployments: [
      { uid: "dpl_fail", projectId: "vercel-project", target: "preview", meta: { previewRepository: "owner/repository", previewPullRequest: "21" } },
      { uid: "dpl_success", projectId: "vercel-project", target: "preview", meta: { previewRepository: "owner/repository", previewPullRequest: "21" } },
    ], pagination: {} });
    return json({ branches: [{ id: "br-preview-21", name: "preview/pr-21" }], pagination: {} });
  };
  await assert.rejects(() => cleanupPreviews({ environment, execute, fetchImpl }), /Railway pr-21.*Vercel dpl_fail/);
  assert.equal(commands.filter((args) => args[0] === "environment" && args[1] === "delete").length, 1);
  assert.equal(deletes.length, 3);
  assert.ok(deletes.some((url) => url.includes("br-preview-21")));
  assert.ok(deletes.some((url) => url.includes("dpl_success")));
});

test("a timed-out Railway command cannot prevent Neon and Vercel cleanup", async () => {
  const providerDeletes = [];
  const events = [];
  const run = (_command, _args, options, callback) => {
    assert.equal(options.timeout, 30_000);
    assert.equal(options.killSignal, "SIGKILL");
    setImmediate(() => {
      events.push("railway timeout");
      callback(Object.assign(new Error("timed out with sensitive details"), { code: "ETIMEDOUT" }), "", "sensitive stderr");
    });
  };
  const execute = (args) => railwayCommand(args, run);
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    assert.ok(options.signal instanceof AbortSignal);
    if (options.method === "DELETE") {
      providerDeletes.push(value);
      events.push(value.includes("api.vercel.com") ? "vercel delete" : "neon delete");
      return json({}, 204);
    }
    if (value.includes("api.vercel.com")) return json({ deployments: [
      { uid: "dpl_timeoutCase", projectId: "vercel-project", target: "preview", meta: { previewRepository: "owner/repository", previewPullRequest: "21" } },
    ], pagination: {} });
    return json({ branches: [{ id: "br-timeout-case", name: "preview/pr-21" }], pagination: {} });
  };
  await assert.rejects(() => cleanupPreviews({ environment, execute, fetchImpl }), /Railway link --project failed/);
  assert.equal(providerDeletes.length, 2);
  assert.ok(events.indexOf("neon delete") < events.indexOf("railway timeout"));
  assert.ok(events.indexOf("vercel delete") < events.indexOf("railway timeout"));
  assert.ok(providerDeletes.some((url) => url.includes("br-timeout-case")));
  assert.ok(providerDeletes.some((url) => url.includes("dpl_timeoutCase")));
});
