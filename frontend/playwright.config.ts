import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "3107";
const failClosedPort = String(Number(port) + 1);
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseUrl ?? `http://127.0.0.1:${port}`;

const webServer = externalBaseUrl ? undefined : [
  {
    command: `npm run start -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/admin`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_API_BASE_URL: "http://api.finite-feed.test",
      RAILWAY_API_BASE_URL: "http://api.finite-feed.test",
      VERCEL_ENV: "production",
      VERCEL_URL: "localhost",
    },
  },
  {
    command: `npm run start -- --hostname 127.0.0.1 --port ${failClosedPort}`,
    url: `http://127.0.0.1:${failClosedPort}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_API_BASE_URL: "http://api.finite-feed.test",
      RAILWAY_API_BASE_URL: "http://api.finite-feed.test",
      VERCEL_ENV: "",
      VERCEL_URL: "",
    },
  },
];

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  outputDir: "test-results",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer,
});
