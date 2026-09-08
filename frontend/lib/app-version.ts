export type AppEnvironment = "production" | "staging" | "preview" | "ci" | "local";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

const configuredVersion = process.env.NEXT_PUBLIC_APP_VERSION?.trim();
const configuredEnvironment = process.env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase();
const configuredCommit = process.env.NEXT_PUBLIC_APP_COMMIT?.trim().toLowerCase();
const knownEnvironments = new Set<AppEnvironment>(["production", "staging", "preview", "ci"]);

export const appVersion = {
  version: VERSION_PATTERN.test(configuredVersion ?? "") ? configuredVersion! : "dev",
  environment: knownEnvironments.has(configuredEnvironment as AppEnvironment) ? configuredEnvironment as AppEnvironment : "local",
  commit: SHA_PATTERN.test(configuredCommit ?? "") ? configuredCommit! : "working-tree",
} as const;

export function appVersionLabel(metadata = appVersion) {
  const shortCommit = metadata.commit === "working-tree" ? metadata.commit : metadata.commit.slice(0, 7);
  if (metadata.environment === "production") return `v${metadata.version} · ${shortCommit}`;
  if (metadata.environment === "staging") return `Next v${metadata.version} · staging/${shortCommit}`;
  if (metadata.environment === "local") return "Local build";
  return `${metadata.environment} v${metadata.version} · ${shortCommit}`;
}
