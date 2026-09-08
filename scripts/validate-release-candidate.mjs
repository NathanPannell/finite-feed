import { pathToFileURL } from "node:url";
import { validateReleaseCandidate } from "./prepare-release.mjs";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const candidate = await validateReleaseCandidate();
  console.log(`Staging candidate ${candidate.candidate} is ready to prepare as v${candidate.version}.`);
}
