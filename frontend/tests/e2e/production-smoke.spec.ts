import { expect, test } from "@playwright/test";

const localRun = !process.env.PLAYWRIGHT_BASE_URL;
const failClosedPort = String(Number(process.env.PLAYWRIGHT_PORT ?? "3107") + 1);

test("@smoke serves public and signed-out surfaces without browser errors", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.route("**/api/personal/**", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ detail: "Sign in" }),
  }));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your attention has better places to be." })).toBeVisible();
  expect(browserErrors).toEqual([]);

  await page.goto("/app");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
});

test("production server fails closed when Vercel admin metadata is absent", async ({ request }) => {
  if (!localRun) {
    const response = await request.get("/admin", { maxRedirects: 0 });
    expect([401, 403, 301, 302, 303, 307, 308]).toContain(response.status());
    if ([301, 302, 303, 307, 308].includes(response.status())) {
      const location = response.headers().location ?? "";
      expect(new URL(location, process.env.PLAYWRIGHT_BASE_URL).hostname).toMatch(/(^|\.)vercel\.(com|app)$/);
    }
    return;
  }

  for (const path of ["/admin", "/api/admin/summary"]) {
    const response = await request.get(`http://127.0.0.1:${failClosedPort}${path}`);
    expect(response.status(), path).toBe(503);
    expect(await response.text(), path).toBe("Admin route unavailable.");
  }
});
