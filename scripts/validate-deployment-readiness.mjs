import { pathToFileURL } from "node:url";

export function validateDeploymentReadiness(payload, options, now = Date.now()) {
  if (payload?.status !== "ready") throw new Error("API is not ready.");
  if (payload.commit !== options.expectedCommit) throw new Error("API commit does not match.");
  if (options.expectedOrigin && !payload.allowed_origins?.includes(options.expectedOrigin)) {
    throw new Error("API does not trust the expected frontend origin.");
  }
  if (!options.requireWorker) return;

  if (payload.worker?.status !== "healthy") throw new Error("Worker is not healthy.");
  if (payload.worker.commit !== options.expectedCommit) throw new Error("Worker commit does not match.");
  const heartbeatAt = Date.parse(payload.worker.last_seen_at);
  if (!Number.isFinite(heartbeatAt)) throw new Error("Worker heartbeat timestamp is invalid.");
  const ageSeconds = (now - heartbeatAt) / 1000;
  if (ageSeconds < -30 || ageSeconds > options.maxWorkerAgeSeconds) throw new Error("Worker heartbeat is not fresh.");
}

function parseArguments(args) {
  const options = { requireWorker: false, maxWorkerAgeSeconds: 180 };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--require-worker") options.requireWorker = true;
    else if (argument === "--expected-commit") options.expectedCommit = args[++index];
    else if (argument === "--expected-origin") options.expectedOrigin = args[++index];
    else if (argument === "--max-worker-age-seconds") options.maxWorkerAgeSeconds = Number(args[++index]);
    else throw new Error(`Unknown readiness argument: ${argument}`);
  }
  if (!options.expectedCommit) throw new Error("--expected-commit is required.");
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  validateDeploymentReadiness(JSON.parse(Buffer.concat(chunks).toString("utf8")), parseArguments(process.argv.slice(2)));
}
