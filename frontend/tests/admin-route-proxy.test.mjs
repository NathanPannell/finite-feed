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

test("preview deployments remain available behind Vercel protection", () => {
  assert.deepEqual(
    adminRouteDecision({
      nodeEnv: "production",
      vercelEnv: "preview",
      requestHostname: "preview.vercel.app",
    }),
    { kind: "allow" },
  );
});
