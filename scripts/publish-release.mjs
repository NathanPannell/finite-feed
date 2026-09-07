import { pathToFileURL } from "node:url";
import { githubJson, normalizeSha, readRepositoryVersion, releaseTag, resolveTagCommit } from "./release-contract.mjs";

export async function publishRelease(environment = process.env, dependencies = {}) {
  const context = { token: environment.GITHUB_TOKEN, repository: environment.GITHUB_REPOSITORY, fetchImpl: dependencies.fetch ?? fetch };
  if (!context.token || !context.repository) throw new Error("Release publication is missing GitHub context.");
  const commit = normalizeSha(environment.EXPECTED_COMMIT_SHA, "Deployed production commit");
  const version = readRepositoryVersion(dependencies.readFileSync);
  const tag = releaseTag(version);
  const taggedCommit = await resolveTagCommit(tag, context);
  if (taggedCommit && taggedCommit !== commit) throw new Error(`Refusing to reuse ${tag}: it points to ${taggedCommit}, not deployed commit ${commit}.`);
  if (!taggedCommit) {
    await githubJson("/git/refs", { ...context, method: "POST", body: { ref: `refs/tags/${tag}`, sha: commit } });
  }
  const existing = await githubJson(`/releases/tags/${encodeURIComponent(tag)}`, { ...context, allowMissing: true });
  if (existing) return existing;
  return githubJson("/releases", {
    ...context,
    method: "POST",
    body: { tag_name: tag, target_commitish: commit, name: tag, generate_release_notes: true },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = await publishRelease();
  console.log(`Release ${release.tag_name} is published at ${process.env.EXPECTED_COMMIT_SHA}.`);
}
