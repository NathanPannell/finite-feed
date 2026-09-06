import { pathToFileURL } from "node:url";

function webUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed;
}

function collectStrings(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, found));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => collectStrings(entry, found));
  return found;
}

export function validatePreviewAuthConfig({
  previewAuthBaseUrl,
  parentAuthBaseUrl,
  previewFrontendUrl,
  trustedDomains,
}) {
  const previewAuth = webUrl(previewAuthBaseUrl, "Preview Neon Auth base URL");
  const parentAuth = webUrl(parentAuthBaseUrl, "Parent Neon Auth base URL");
  if (previewAuth.origin === parentAuth.origin) {
    throw new Error("Preview Neon Auth must use a branch-specific origin, not the parent branch endpoint");
  }

  let frontend;
  if (previewFrontendUrl) {
    frontend = webUrl(previewFrontendUrl, "Preview frontend URL");
    if (!frontend.hostname.endsWith(".vercel.app") || frontend.pathname !== "/") {
      throw new Error("Preview frontend URL must be a Vercel preview origin");
    }
    if (trustedDomains !== undefined) {
      const exactOrigin = frontend.origin;
      const configured = collectStrings(trustedDomains).some((value) => {
        try {
          const candidate = webUrl(value, "Trusted domain");
          return candidate.pathname === "/" && candidate.origin === exactOrigin;
        } catch {
          return false;
        }
      });
      if (!configured) throw new Error("Current Vercel preview origin is not trusted by this Neon Auth branch");
    }
  }

  const callback = new URL(previewAuth.href);
  callback.pathname = `${previewAuth.pathname}/callback/google`;
  return {
    callbackUrl: callback.href,
    previewAuthOrigin: previewAuth.origin,
    previewFrontendOrigin: frontend?.origin,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const domains = process.env.NEON_AUTH_DOMAINS_JSON
      ? JSON.parse(process.env.NEON_AUTH_DOMAINS_JSON)
      : undefined;
    const result = validatePreviewAuthConfig({
      previewAuthBaseUrl: process.env.NEON_AUTH_BASE_URL,
      parentAuthBaseUrl: process.env.PARENT_NEON_AUTH_BASE_URL,
      previewFrontendUrl: process.env.EXPECTED_FRONTEND_ORIGIN,
      trustedDomains: domains,
    });
    process.stdout.write(result.callbackUrl);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid preview auth configuration");
    process.exitCode = 1;
  }
}
