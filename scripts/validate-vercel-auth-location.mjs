import { pathToFileURL } from "node:url";

const AUTH_PATHS = ["/sso", "/sso-api", "/login", "/api/auth", "/_vercel"];

export function isVercelAuthLocation(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/_vercel/")) return true;

  let location;
  try {
    location = new URL(value);
  } catch {
    return false;
  }

  const trustedHost = location.hostname === "vercel.com" || location.hostname.endsWith(".vercel.com");
  const trustedPath = AUTH_PATHS.some((prefix) =>
    location.pathname === prefix || location.pathname.startsWith(prefix + "/"),
  );
  return location.protocol === "https:" && location.port === "" && trustedHost && trustedPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = isVercelAuthLocation(process.argv[2]) ? 0 : 1;
}