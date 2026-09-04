import { expect, test } from "@playwright/test";

test("operates the private admin dashboard through its server API contract", async ({ page }) => {
  const requestedUrls: string[] = [];
  let createBody: Record<string, unknown> | null = null;

  await page.route("**/api/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/admin/", "");
    requestedUrls.push(`${path}${url.search}`);

    if (path === "summary") {
      await route.fulfill({ json: {
        active_channels: 1,
        video_count: 1,
        recommendation_count: 1,
        queued_recommendations: 0,
        delivered_recommendations: 1,
        latest_ingestion_status: "complete",
        owner_options: [
          { id: "owner-1", name: "Ada" },
          { id: "owner-2", name: "Grace" },
        ],
        channels: [{ id: "channel-1", name: "Existing Channel" }],
      } });
      return;
    }
    if (path === "activity") {
      await route.fulfill({ json: { items: [], total: 0, page: 1, page_size: 12 } });
      return;
    }
    if (path === "channels/resolve") {
      await route.fulfill({ json: {
        name: "New Channel",
        description: "A resolved channel",
        subscriber_count: 1200,
        public_video_count: 42,
        already_tracked: false,
        is_active: false,
      } });
      return;
    }
    if (path === "channels" && request.method() === "POST") {
      createBody = request.postDataJSON();
      await route.fulfill({ json: { id: "channel-2", reactivated: false } });
      return;
    }
    if (path === "channels") {
      await route.fulfill({ json: { items: [{
        id: "channel-1",
        name: "Existing Channel",
        owner_name: "Ada",
        is_active: true,
        max_video_age_days: 7,
        ingested_video_count: 1,
        sync_status: "complete",
        canonical_url: "https://youtube.com/@existing",
      }], total: 1, page: 1, page_size: 25 } });
      return;
    }
    if (path === "videos/vector-search") {
      await route.fulfill({ json: { items: [{
        id: "video-2",
        title: "Semantic Video",
        channel_name: "Existing Channel",
        youtube_url: "https://youtube.com/watch?v=semantic",
        similarity: 0.875,
        embedding_model: "Snowflake/snowflake-arctic-embed-xs",
      }], total: 1, page: 1, page_size: 20 } });
      return;
    }
    if (path === "videos") {
      await route.fulfill({ json: { items: [{
        id: "video-1",
        title: "Recent Video",
        channel_name: "Existing Channel",
        youtube_url: "https://youtube.com/watch?v=recent",
        published_at: "2026-09-03T12:00:00Z",
        has_embedding: true,
        embedding_model: "Snowflake/snowflake-arctic-embed-xs",
      }], total: 1, page: 1, page_size: 25 } });
      return;
    }
    if (path === "recommendations") {
      await route.fulfill({ json: { items: [{
        id: "recommendation-1",
        recipient_name: "Ada",
        video_title: "Recent Video",
        channel_name: "Existing Channel",
        rationale: "Matches current interests",
        delivered_at: "2026-09-03T13:00:00Z",
        rating: "up",
      }], total: 1, page: 1, page_size: 25 } });
      return;
    }
    if (path === "videos/video-1") {
      await route.fulfill({ json: { id: "video-1", title: "Recent Video", transcript: "Full details" } });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "Unexpected test route" } });
  });

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Control room", level: 1 })).toBeVisible();
  await expect(page.getByText("Existing Channel", { exact: true }).first()).toBeVisible();

  await page.getByLabel("Owner").selectOption("owner-2");
  await page.getByLabel("YouTube channel URL").fill("https://youtube.com/@newchannel");
  await expect(page.getByText("New Channel", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Add channel/ }).click();
  await expect(page.getByRole("status")).toContainText("Channel added");
  expect(createBody).toMatchObject({
    url: "https://youtube.com/@newchannel",
    max_video_age_days: 7,
    user_id: "owner-2",
  });

  const channelsTab = page.getByRole("tab", { name: "Channels" });
  await channelsTab.focus();
  await channelsTab.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Videos" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Recent Video", { exact: true })).toBeVisible();

  await page.getByText("More filters").click();
  await page.getByLabel("Published after").fill("2026-09-01");
  await page.getByLabel("Ingested after").fill("2026-09-02");
  await expect.poll(() => requestedUrls.some((url) =>
    url.includes("published_after=2026-09-01") && url.includes("ingested_after=2026-09-02"),
  )).toBe(true);

  await page.getByLabel("Search mode").selectOption("vector");
  await page.getByPlaceholder("Describe an idea to retrieve").fill("systems thinking");
  await page.getByRole("button", { name: "Search meaning" }).click();
  await expect(page.getByText("Semantic Video", { exact: true })).toBeVisible();
  await expect(page.getByText("0.875 semantic similarity", { exact: true })).toBeVisible();

  await page.getByText("Choose columns").click();
  await page.getByLabel("Views").uncheck();
  await expect(page.getByRole("columnheader", { name: "Views" })).toBeHidden();

  await page.getByRole("tab", { name: "Recommendations" }).click();
  await page.getByLabel("State").selectOption("delivered");
  await expect.poll(() => requestedUrls.some((url) => url.includes("delivery_state=delivered"))).toBe(true);
  await expect(page.getByText("Matches current interests", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 800 });
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.inner);
});
