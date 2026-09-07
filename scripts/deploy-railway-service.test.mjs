import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const isWindows = process.platform === "win32";

test("a rerun changes the uploaded source stamp and accepts a fresh deployment ID", { skip: isWindows }, async () => {
  const root = await mkdtemp(join(tmpdir(), "finite-feed-railway-deploy-"));
  const bin = join(root, "bin");
  const backend = join(root, "backend");
  const artifacts = join(root, "artifacts");
  const state = join(root, "deployment-state");
  const captured = join(root, "captured-stamps");
  await Promise.all([mkdir(bin), mkdir(backend), mkdir(artifacts)]);

  const git = `#!/usr/bin/env bash\nprintf '%s\\n' "$EXPECTED_COMMIT_SHA"\n`;
  const railway = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "deployment" ]]; then
  if [[ -f "$FAKE_RAILWAY_STATE" ]]; then
    id="$(cat "$FAKE_RAILWAY_STATE")"
    printf '[{"id":"%s","status":"SUCCESS"}]\\n' "$id"
  else
    printf '[]\\n'
  fi
elif [[ "$1" == "up" ]]; then
  printf '%s\\n' "deployment-$GITHUB_RUN_ATTEMPT" > "$FAKE_RAILWAY_STATE"
  cat backend/.railway-deployment-source >> "$CAPTURED_STAMPS"
else
  exit 2
fi
`;
  await Promise.all([
    writeFile(join(bin, "git"), git),
    writeFile(join(bin, "railway"), railway),
  ]);
  await Promise.all([chmod(join(bin, "git"), 0o755), chmod(join(bin, "railway"), 0o755)]);

  const script = resolve("scripts/deploy-railway-service.sh");
  for (const attempt of ["1", "2"]) {
    const result = spawnSync("bash", [script, "worker-service", "worker"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        EXPECTED_COMMIT_SHA: "a".repeat(40),
        RAILWAY_PROJECT_ID: "project",
        RAILWAY_ENVIRONMENT: "pr-42",
        DEPLOYMENT_ARTIFACT_DIR: artifacts,
        GITHUB_RUN_ID: "9001",
        GITHUB_RUN_ATTEMPT: attempt,
        FAKE_RAILWAY_STATE: state,
        CAPTURED_STAMPS: captured,
      },
    });
    assert.equal(result.status, 0, result.stderr);
  }

  assert.deepEqual((await readFile(captured, "utf8")).trim().split("\n"), [
    `${"a".repeat(40)}:worker:9001:1`,
    `${"a".repeat(40)}:worker:9001:2`,
  ]);
  const evidence = JSON.parse(await readFile(join(artifacts, "railway-worker-deployment.json"), "utf8"));
  assert.equal(evidence.deployment_id, "deployment-2");
  assert.equal(evidence.result, "SUCCESS");
});
