import { defineConfig, devices } from "@playwright/test";

const port = 3113;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "developer-preview-auth.spec.ts",
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_API_BASE_URL: "http://api.finite-feed.test",
      RAILWAY_API_BASE_URL: "http://api.finite-feed.test",
      NEON_AUTH_BASE_URL: "https://auth.finite-feed.test/neondb/auth",
      NEON_AUTH_COOKIE_SECRET: "preview-auth-test-cookie-secret-is-at-least-32-characters",
      VERCEL_ENV: "preview",
      DEVELOPER_PREVIEW_AUTH: "true",
    },
  },
});
