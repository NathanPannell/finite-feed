import { expect, test } from "@playwright/test";

test("operates the records-first admin dashboard through its server API contract", async ({ page }, testInfo) => {
  const requestedUrls: string[] = [];
  let createBody: Record<string, unknown> | null = null;
  let channelActive = true;
  let failNextChannelPatch = false;

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
      await route.fulfill({ json: [{
        created_at: "2026-09-03T14:25:00Z",
        event_type: "ingestion",
        source: "Worker",
        result: "complete",
        target_id: "internal-hash-must-not-render",
      }] });
      return;
    }
    if (path === "performance") {
      await route.fulfill({ json: [
        { day: "2026-08-05", up_count: 0, down_count: 0, sent_count: 1, up_share: 0 },
        { day: "2026-08-20", up_count: 2, down_count: 1, sent_count: 4, up_share: 0.5 },
        { day: "2026-09-03", up_count: 3, down_count: 1, sent_count: 5, up_share: 0.6 },
      ] });
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
    if (path === "channels/channel-1" && request.method() === "PATCH") {
      if (failNextChannelPatch) {
        failNextChannelPatch = false;
        await route.fulfill({ status: 503, json: { detail: "Tracking service is unavailable." } });
        return;
      }
      channelActive = Boolean((request.postDataJSON() as Record<string, unknown>).is_active);
      await route.fulfill({ json: { id: "channel-1", is_active: channelActive } });
      return;
    }
    if (path === "channels") {
      if (url.searchParams.get("search") === "missing") {
        await route.fulfill({ json: { items: [], total: 0, page: 1, page_size: 25 } });
        return;
      }
      await route.fulfill({ json: { items: [{
        id: "channel-1",
        user_id: "owner-internal-id",
        name: "Existing Channel",
        owner_name: "Ada",
        thumbnail_url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='%233157e8'/%3E%3C/svg%3E",
        is_active: channelActive,
        max_video_age_days: 7,
        ingested_video_count: 1,
        sync_status: "complete",
        last_sync_completed_at: "2026-09-03T14:25:00Z",
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
        youtube_url: "https://youtube.com/watch?v=recent",
        thumbnail_url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='100'%3E%3Crect width='160' height='100' fill='%23111111'/%3E%3C/svg%3E",
        video_published_at: "2026-09-03T12:00:00Z",
        video_duration_seconds: 720,
        video_view_count: 12400,
        rationale: "Matches current interests",
        created_at: "2026-09-03T12:30:00Z",
        delivered_at: "2026-09-03T13:00:00Z",
        clicked_at: "2026-09-03T13:10:00Z",
        last_interacted_at: "2026-09-03T13:12:00Z",
        last_interaction_type: "feedback_up",
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

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Control room", level: 1 })).toBeVisible();
  await expect(page.getByText("Inspect the pipeline", { exact: false })).toHaveCount(0);
  await expect(page.getByLabel("Latest activity")).toHaveCount(1);
  await expect(page.getByLabel("Latest activity")).toContainText("ingestion");
  await expect(page.getByLabel("Latest activity")).toContainText("Worker");
  await expect(page.getByText("internal-hash-must-not-render")).toHaveCount(0);
  await expect(page.getByText("Existing Channel", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("status")).toContainText("1 channels loaded");
  await expect(page.getByLabel("Owner")).toHaveCount(0);
  const recordsBox = await page.getByRole("tabpanel").boundingBox();
  const healthBox = await page.getByRole("heading", { name: "System health" }).boundingBox();
  expect(recordsBox?.y).toBeLessThan(healthBox?.y ?? Infinity);
  expect(recordsBox?.y).toBeLessThan(720);
  await page.screenshot({ path: testInfo.outputPath("admin-desktop.png"), fullPage: true });

  await page.locator(".admin-performance > details > summary").click();
  await expect(page.getByRole("img", { name: "Useful and not useful feedback over time" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Useful feedback as a share of recommendations sent" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Daily feedback data" })).toContainText("60%");

  const channelRow = page.getByRole("row").filter({ hasText: "Existing Channel" });
  const channelLogo = channelRow.locator("img");
  const logoBox = await channelLogo.boundingBox();
  expect(logoBox?.width).toBeGreaterThanOrEqual(64);
  expect(logoBox?.width).toBe(logoBox?.height);
  await expect(channelRow.getByRole("button", { name: "Details" })).toBeVisible();
  const syncText = await channelRow.locator(".admin-last-sync").innerText();
  expect(syncText).not.toContain("2026");
  expect(syncText).toContain("Sep");
  await channelRow.getByRole("button", { name: "Details" }).click();
  const channelDialog = page.getByRole("dialog");
  await expect(channelDialog.getByText("owner name", { exact: true })).toHaveCount(0);
  await expect(channelDialog.getByText("user id", { exact: true })).toHaveCount(0);
  await expect(channelDialog.getByText("Technical details", { exact: false })).toBeVisible();
  await expect(channelDialog.getByText("channel-1", { exact: true })).toBeHidden();
  await channelDialog.getByRole("button", { name: "Close details" }).click();

  const stopButton = channelRow.getByRole("button", { name: "Pause tracking" });
  const stopColor = await stopButton.evaluate((element) => getComputedStyle(element).color);
  expect(stopColor).toBe("rgb(142, 40, 29)");
  const stopBoxBefore = await stopButton.boundingBox();
  await channelRow.getByRole("button", { name: "Increase Video window for Existing Channel" }).click();
  await expect(channelRow.getByRole("button", { name: "Save" })).toBeVisible();
  const stopBoxAfter = await stopButton.boundingBox();
  expect(stopBoxAfter?.x).toBe(stopBoxBefore?.x);

  await stopButton.click();
  await expect(channelRow.getByText("Pause tracking for Existing Channel?", { exact: true })).toBeVisible();
  await channelRow.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".admin-notice")).toContainText("Tracking paused");
  const restoreButton = channelRow.getByRole("button", { name: "Restore tracking" });
  await expect(restoreButton).toBeVisible();
  const restoreColor = await restoreButton.evaluate((element) => getComputedStyle(element).color);
  expect(restoreColor).toBe("rgb(23, 93, 58)");
  await restoreButton.click();
  await expect(channelRow.getByRole("button", { name: "Pause tracking" })).toBeVisible();

  failNextChannelPatch = true;
  await channelRow.getByRole("button", { name: "Pause tracking" }).click();
  await channelRow.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".admin-notice.error")).toContainText("previous tracking state was restored");
  await expect(channelRow.getByRole("button", { name: "Pause tracking" })).toBeVisible();

  await page.getByText("Add a tracked channel", { exact: false }).click();
  await page.getByLabel("YouTube channel URL").fill("https://youtube.com/@newchannel");
  await expect(page.getByText("New Channel", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Add channel/ }).click();
  await expect(page.locator(".admin-notice")).toContainText("Channel added");
  expect(createBody).toMatchObject({
    url: "https://youtube.com/@newchannel",
    max_video_age_days: 7,
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
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByLabel("Published after")).toHaveValue("");

  await page.getByRole("tab", { name: "Channels" }).click();
  await page.getByPlaceholder("Search channels").fill("missing");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No matching channels" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText("Existing Channel", { exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Videos" }).click();

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
  const recommendationRow = page.getByRole("row").filter({ hasText: "Recent Video" });
  await expect(recommendationRow.getByRole("link", { name: "Watch video" })).toHaveAttribute("href", "https://youtube.com/watch?v=recent");
  await expect(recommendationRow).toContainText("Existing Channel");
  await expect(recommendationRow).toContainText("12m");
  await expect(recommendationRow).toContainText("12K views");
  await expect(recommendationRow.locator(".admin-timeline li")).toHaveCount(4);
  await expect(recommendationRow).toContainText("Created");
  await expect(recommendationRow).toContainText("Delivered");
  await expect(recommendationRow).toContainText("Clicked");
  await expect(recommendationRow).toContainText("feedback up");
  await recommendationRow.getByText("Why this matched").click();
  await expect(page.getByText("Matches current interests", { exact: true })).toBeVisible();

  await page.locator(".admin-performance > details > summary").click();
  await page.setViewportSize({ width: 720, height: 800 });
  const zoomWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(zoomWidth.scroll).toBeLessThanOrEqual(zoomWidth.inner);
  const timelineFontSize = await recommendationRow.locator(".admin-timeline time").first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(timelineFontSize).toBeGreaterThanOrEqual(12);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByLabel("Latest activity")).toBeVisible();
  await expect(recommendationRow.getByRole("button", { name: "Details" })).toBeVisible();
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.inner);
  await page.screenshot({ path: testInfo.outputPath("admin-mobile.png"), fullPage: true });
});

test("announces loading and recovers from a list error into an empty state", async ({ page }) => {
  let releaseChannels: (() => void) | undefined;
  const heldChannels = new Promise<void>((resolve) => { releaseChannels = resolve; });
  let channelAttempts = 0;

  await page.route("**/api/admin/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/admin/", "");
    if (path === "channels") {
      channelAttempts += 1;
      if (channelAttempts === 1) {
        await heldChannels;
        await route.fulfill({ status: 503, json: { detail: "Channel records are temporarily unavailable." } });
        return;
      }
      await route.fulfill({ json: { items: [], total: 0, page: 1, page_size: 25 } });
      return;
    }
    if (path === "summary") { await route.fulfill({ json: {} }); return; }
    if (path === "activity" || path === "performance") { await route.fulfill({ json: [] }); return; }
    await route.fulfill({ status: 404, json: { detail: "Unexpected test route" } });
  });

  await page.goto("/admin");
  await expect(page.getByRole("status")).toContainText("Loading channels");
  releaseChannels?.();
  await expect(page.locator(".admin-error")).toContainText("Channel records are temporarily unavailable");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "No channels yet" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("0 channels loaded");
});
