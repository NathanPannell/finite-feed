import { expect, Page, Route, test } from "@playwright/test";

const apiOrigin = "http://api.finite-feed.test";

function json(route: Route, payload: unknown) {
  return route.fulfill({
    json: payload,
    headers: { "access-control-allow-origin": "*" },
  });
}

async function mockPublicApi(page: Page) {
  let feedbackId = "";
  await page.route(apiOrigin + "/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (/\/api\/recommendations\/[^/]+\/feedback$/.test(url.pathname)) {
      feedbackId = url.pathname.split("/").at(-2) ?? "";
      const rating = request.postDataJSON().rating;
      return json(route, {
        id: feedbackId,
        title: feedbackId === "rec-1" ? "How to make hard choices" : "The architecture of attention",
        speaker: "Ada Reed",
        channel_name: "TED",
        youtube_url: "https://youtube.com/watch?v=signal",
        published_at: "2026-09-01T12:00:00Z",
        duration_seconds: 1080,
        rationale: "It turns a broad interest into one practical decision model.",
        rating,
        clicked_at: null,
        created_at: "2026-09-03T12:00:00Z",
      });
    }

    if (url.pathname === "/api/recommendations/generate") {
      return json(route, {});
    }

    if (url.pathname === "/api/profile") {
      return json(route, {
        preference_statement: "Rigorous ideas about systems, human judgment, and better decisions.",
        timezone: "America/Los_Angeles",
        cadence_days: [2, 5],
        delivery_hour: 9,
        recommendation_count: 1,
        version: 4,
        updated_at: "2026-09-03T12:00:00Z",
      });
    }

    if (url.pathname === "/api/channels") {
      return json(route, [
        { id: "channel-1", name: "TED", url: "https://youtube.com/@ted", is_default: true },
        { id: "channel-2", name: "MIT OpenCourseWare", url: "https://youtube.com/@mitocw", is_default: false },
      ]);
    }

    if (url.pathname === "/api/recommendations") {
      return json(route, [
        {
          id: "rec-1",
          title: "How to make hard choices",
          speaker: "Ada Reed",
          channel_name: "TED",
          youtube_url: "https://youtube.com/watch?v=signal",
          published_at: "2026-09-01T12:00:00Z",
          duration_seconds: 1080,
          rationale: "It turns a broad interest into one practical decision model.",
          rating: null,
          clicked_at: null,
          created_at: "2026-09-03T12:00:00Z",
        },
        {
          id: "rec-2",
          title: "The architecture of attention",
          speaker: null,
          channel_name: "TEDx",
          youtube_url: "https://youtube.com/watch?v=archive",
          published_at: "2026-08-28T12:00:00Z",
          duration_seconds: 840,
          rationale: "A concise framework for protecting focus without productivity theater.",
          rating: "up",
          clicked_at: null,
          created_at: "2026-09-02T12:00:00Z",
        },
      ]);
    }

    if (url.pathname === "/api/metrics") {
      return json(route, { delivered: 8, clicked: 6, rated_up: 4, rated_down: 1, click_through_rate: .75, thumbs_up_share: .8 });
    }

    if (url.pathname === "/api/pipeline/status") {
      return json(route, { videos: 251, embedded_videos: 251, last_ingestion_status: "complete", last_ingestion_at: "2026-09-03T12:00:00Z" });
    }

    return json(route, {});
  });
  return () => feedbackId;
}

test("renders the public signal, recent ledger, preferences, and persistent feedback", async ({ page }) => {
  const feedbackId = await mockPublicApi(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Fewer things/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How to make hard choices" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The architecture of attention" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Match Lab" })).toHaveAttribute("href", "/match");
  await expect(page.getByRole("button", { name: "Remove MIT OpenCourseWare" })).toBeVisible();
  await expect(page.getByLabel("What should feel unusually valuable?")).toContainText("Rigorous ideas");

  await page.getByRole("button", { name: "Useful" }).first().click();
  await expect(page.getByRole("button", { name: "Useful" }).first()).toHaveAttribute("aria-pressed", "true");
  expect(feedbackId()).toBe("rec-1");
});

test("keeps the public page inside a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockPublicApi(page);
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.inner);
});

test("shows caught up after the final reasoned match judgment", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  let annotationBody: Record<string, unknown> | null = null;
  let saved = false;
  await page.route(apiOrigin + "/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/annotations/next") {
      if (saved) return json(route, null);
      return json(route, {
        profile_id: "profile-1",
        video_id: "video-1",
        summary: "Wants practical systems thinking without motivational filler.",
        topics: ["systems", "judgment"],
        title: "The hidden logic of everyday choices",
        description: "A researcher explains why small decisions compound into structural outcomes and how viewers can apply the framework without losing the important context. ".repeat(4),
        thumbnail_url: "https://i.ytimg.com/vi/video-1/hqdefault.jpg",
      });
    }
    if (url.pathname === "/api/annotations/stats") {
      return json(route, saved ? { completed: 4, remaining: 0 } : { completed: 3, remaining: 1 });
    }
    if (url.pathname === "/api/annotations" && request.method() === "POST") {
      annotationBody = request.postDataJSON();
      saved = true;
      return json(route, { saved: true });
    }
    return json(route, {});
  });
  await page.route("**/_next/image?**", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  }));

  await page.goto("/match");
  await expect(page.getByRole("heading", { name: /Does this belong/ })).toBeVisible();
  await expect(page.locator(".signal-masthead-title")).toHaveText("Does this belong?");
  await expect(page.getByRole("heading", { name: "Make one clear call." })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await page.getByRole("link", { name: "OK, let's begin" }).click();
  await expect(page).toHaveURL(/\/match\/review$/);
  await expect(page.locator(".match-progress")).toHaveCount(0);
  await expect(page.locator(".match-video-thumbnail")).toHaveAttribute("src", /hqdefault\.jpg/);
  await expect(page.getByRole("button", { name: "Show full description" })).toBeVisible();
  await page.getByRole("button", { name: "Show full description" }).click();
  await expect(page.getByRole("button", { name: "Show less" })).toBeVisible();
  await page.getByRole("button", { name: "Show less" }).click();
  const desktopGeometry = await page.locator(".signal-masthead, .signal-masthead-title, .signal-masthead nav").evaluateAll(([header, title, nav]) => {
    const headerBox = header.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    const navBox = nav.getBoundingClientRect();
    return {
      headerCenter: headerBox.left + headerBox.width / 2,
      titleCenter: titleBox.left + titleBox.width / 2,
      titleRight: titleBox.right,
      navLeft: navBox.left,
    };
  });
  expect(Math.abs(desktopGeometry.headerCenter - desktopGeometry.titleCenter)).toBeLessThanOrEqual(2);
  expect(desktopGeometry.titleRight).toBeLessThan(desktopGeometry.navLeft);
  await expect(page.getByRole("heading", { name: "Viewer" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Video" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Action" })).toBeVisible();
  const workspaceGeometry = await page.locator(".match-workspace, .match-profile, .match-video, .match-response").evaluateAll(([workspace, viewer, video, action]) => {
    const workspaceWidth = workspace.getBoundingClientRect().width;
    return {
      evidenceShare: (viewer.getBoundingClientRect().width + video.getBoundingClientRect().width) / workspaceWidth,
      actionShare: action.getBoundingClientRect().width / workspaceWidth,
    };
  });
  expect(workspaceGeometry.evidenceShare).toBeGreaterThan(.74);
  expect(workspaceGeometry.actionShare).toBeLessThan(.26);
  await expect(page.getByRole("button", { name: "Yes" })).toHaveCSS("background-color", "rgb(23, 93, 58)");
  await expect(page.getByRole("button", { name: "No" })).toHaveCSS("background-color", "rgb(142, 40, 29)");
  await expect(page.getByRole("button", { name: "Unsure" })).toHaveCSS("background-color", "rgb(250, 249, 242)");
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
  const mobileOrder = await page.locator(".match-profile, .match-video, .match-response").evaluateAll(([viewer, video, action]) => ({
    viewerTop: viewer.getBoundingClientRect().top,
    videoTop: video.getBoundingClientRect().top,
    actionTop: action.getBoundingClientRect().top,
  }));
  expect(mobileOrder.viewerTop).toBeLessThan(mobileOrder.videoTop);
  expect(mobileOrder.videoTop).toBeLessThan(mobileOrder.actionTop);
  const activeWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(activeWidth.scroll).toBeLessThanOrEqual(activeWidth.inner);
  await page.setViewportSize({ width: 1024, height: 800 });
  expect(await page.locator(".match-video-thumbnail").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Yes" }).click();
  await expect(page.getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Reason Optional, but useful when it is close.").fill("The method directly matches the viewer's stated interest.");
  await page.getByRole("button", { name: "Save judgment" }).click();

  await expect(page.getByRole("status")).toContainText("Every available pair has a judgment");
  await expect(page.getByRole("heading", { name: /caught up/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The lab lost its signal." })).toHaveCount(0);
  expect(annotationBody).toMatchObject({
    profile_id: "profile-1",
    video_id: "video-1",
    label: "yes",
    rationale: "The method directly matches the viewer's stated interest.",
  });
  await page.setViewportSize({ width: 320, height: 800 });
  const mobileGeometry = await page.locator(".signal-masthead, .signal-masthead-title").evaluateAll(([header, title]) => {
    const headerBox = header.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    return { headerCenter: headerBox.left + headerBox.width / 2, titleCenter: titleBox.left + titleBox.width / 2 };
  });
  expect(Math.abs(mobileGeometry.headerCenter - mobileGeometry.titleCenter)).toBeLessThanOrEqual(2);
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.inner);
});
