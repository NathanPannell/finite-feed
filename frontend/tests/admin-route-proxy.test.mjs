import assert from "node:assert/strict";
import test from "node:test";

const { adminRouteDecision } = await import("../lib/admin-route-gate.ts");

test("local development and tests remain usable", () => {
  assert.deepEqual(
    adminRouteDecision({ nodeEnv: "development", requestHostname: "localhost" }),
    { kind: "allow" },
  );
  assert.deepEqual(
    adminRouteDecision({ nodeEnv: "test", requestHostname: "localhost" }),
    { kind: "allow" },
  );
});

test("production-like unknown state fails closed", () => {
  assert.deepEqual(
    adminRouteDecision({ nodeEnv: "production", requestHostname: "finite.example" }),
    { kind: "deny" },
  );
  assert.deepEqual(
    adminRouteDecision({
      nodeEnv: "production",
      vercelEnv: "production",
      requestHostname: "finite.example",
    }),
    { kind: "deny" },
  );
});

test("production custom aliases redirect while the protected host is allowed", () => {
  const input = {
    nodeEnv: "production",
    vercelEnv: "production",
    vercelUrl: "finite-generated.vercel.app",
  };
  assert.deepEqual(
    adminRouteDecision({ ...input, requestHostname: "finite.example" }),
    { kind: "redirect", host: "finite-generated.vercel.app" },
  );
  assert.deepEqual(
    adminRouteDecision({ ...input, requestHostname: "FINITE-GENERATED.VERCEL.APP" }),
    { kind: "allow" },
  );
});

test("stable staging alias redirects admin routes to its protected generated deployment", () => {
  const input = {
    appEnvironment: "staging",
    nodeEnv: "production",
    vercelEnv: "preview",
    vercelUrl: "finite-staging-generated.vercel.app",
  };
  assert.deepEqual(
    adminRouteDecision({ ...input, requestHostname: "finite-feed-staging.vercel.app" }),
    { kind: "redirect", host: "finite-staging-generated.vercel.app" },
  );
  assert.deepEqual(
    adminRouteDecision({ ...input, requestHostname: "FINITE-STAGING-GENERATED.VERCEL.APP" }),
    { kind: "allow" },
  );
  assert.deepEqual(
    adminRouteDecision({ ...input, vercelUrl: "", requestHostname: "finite-feed-staging.vercel.app" }),
    { kind: "deny" },
  );
});

test("preview deployments remain available behind Vercel protection", () => {
  assert.deepEqual(
    adminRouteDecision({
      nodeEnv: "production",
      vercelEnv: "preview",
      appEnvironment: "preview",
      requestHostname: "preview.vercel.app",
    }),
    { kind: "allow" },
  );
});
