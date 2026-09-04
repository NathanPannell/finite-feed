import { createNeonAuth } from "@neondatabase/auth/next/server";

function requiredEnvironment(name: "NEON_AUTH_BASE_URL" | "NEON_AUTH_COOKIE_SECRET") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Google sign-in.`);
  return value;
}

export const auth = createNeonAuth({
  baseUrl: requiredEnvironment("NEON_AUTH_BASE_URL"),
  cookies: { secret: requiredEnvironment("NEON_AUTH_COOKIE_SECRET") },
});
