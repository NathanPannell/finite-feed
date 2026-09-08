import assert from "node:assert/strict";
import test from "node:test";
import { domainOrigins, reconcileNeonStagingDomains } from "./reconcile-neon-staging-domains.mjs";

const environment = {
  NEON_PROJECT_ID: "project", NEON_BRANCH: "staging",
  STAGING_FRONTEND_URL: "https://staging.example",
  STAGING_DEPLOYMENT_URL: "https://generated.vercel.app",
};

test("extracts only exact HTTPS origins from domain listings", () => {
  assert.deepEqual([...domainOrigins({ domains: [
    { domain: "https://staging.example" }, { domain: "http://unsafe.example" },
    { id: "domain-id", nested: "https://generated.vercel.app/path" },
  ] })], ["https://staging.example"]);
});

test("adds missing staging origin and deletes every inherited origin", () => {
  let current = new Set(["https://production.example", "https://staging.example"]);
  const calls = [];
  const execute = (args) => {
    calls.push(args);
    if (args[2] === "list") return JSON.stringify({ domains: [...current].map((domain) => ({ domain })) });
    const origin = args[3];
    if (args[2] === "add") current.add(origin);
    if (args[2] === "delete") current.delete(origin);
    return "";
  };
  assert.deepEqual(reconcileNeonStagingDomains(environment, execute), { added: 1, removed: 1 });
  assert.deepEqual([...current].sort(), ["https://generated.vercel.app", "https://staging.example"]);
  assert.ok(calls.some((args) => args[2] === "delete" && args[3] === "https://production.example"));
});

test("never targets a branch other than staging", () => {
  assert.throws(() => reconcileNeonStagingDomains({ ...environment, NEON_BRANCH: "production" }, () => "{}"), /must be named staging/);
});

test("rejects paths, ports, and non-HTTPS trusted domains", () => {
  for (const value of ["http://staging.example", "https://staging.example/path", "https://staging.example:444"]) {
    assert.throws(() => reconcileNeonStagingDomains({ ...environment, STAGING_FRONTEND_URL: value }, () => "{}"), /exact HTTPS origins/);
  }
});
