import assert from "node:assert/strict";
import test from "node:test";

import { validateDeploymentReadiness } from "./validate-deployment-readiness.mjs";

const expectedCommit = "a".repeat(40);
const now = Date.parse("2026-09-06T17:00:00Z");
const payload = {
  status: "ready",
  commit: expectedCommit,
  allowed_origins: ["https://finite.example"],
  worker: { status: "healthy", commit: expectedCommit, last_seen_at: "2026-09-06T16:58:30Z" },
};

test("accepts an exact API and fresh healthy worker deployment", () => {
  validateDeploymentReadiness(payload, {
    expectedCommit,
    expectedOrigin: "https://finite.example",
    requireWorker: true,
    maxWorkerAgeSeconds: 180,
  }, now);
});

test("rejects a stale API deployment", () => {
  assert.throws(() => validateDeploymentReadiness({ ...payload, commit: "old" }, { expectedCommit }, now), /API commit/);
});

test("rejects a worker from another deployment", () => {
  assert.throws(() => validateDeploymentReadiness({
    ...payload,
    worker: { ...payload.worker, commit: "old" },
  }, { expectedCommit, requireWorker: true, maxWorkerAgeSeconds: 180 }, now), /Worker commit/);
});

test("rejects a stale worker heartbeat", () => {
  assert.throws(() => validateDeploymentReadiness({
    ...payload,
    worker: { ...payload.worker, last_seen_at: "2026-09-06T16:30:00Z" },
  }, { expectedCommit, requireWorker: true, maxWorkerAgeSeconds: 180 }, now), /not fresh/);
});

test("rejects an API without the intended frontend origin", () => {
  assert.throws(() => validateDeploymentReadiness(payload, {
    expectedCommit,
    expectedOrigin: "https://other.example",
  }, now), /expected frontend origin/);
});
