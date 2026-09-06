import { expect, Page, Route, test } from "@playwright/test";



function json(route: Route, payload: unknown) {
  const appOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3107"}`;
  return route.fulfill({
    json: payload,
    headers: {
      "access-control-allow-origin": appOrigin,
      "access-control-allow-credentials": "true",
    },
  });
}

async function mockPublicApi(page: Page) {
  let feedbackId = "";
  let profilePayload: Record<string, unknown> | null = null;
  let memoryPayload: Record<string, unknown> | null = null;
  let channelPayload: Record<string, unknown> | null = null;
  await page.route("**/api/personal/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (/\/api\/personal\/recommendations\/[^/]+\/feedback$/.test(url.pathname)) {
      feedbackId = url.pathname.split("/").at(-2) ?? "";
      const rating = request.postDataJSON().rating;
      return json(route, {
        id: feedbackId,
        title: feedbackId === "rec-1" ? "How to make hard choices" : "The architecture of attention",
        speaker: "Ada Reed",
        channel_name: "TED",
        thumbnail_url: "https://images.example.test/signal.jpg",
        duration_seconds: 1080,
        rationale: "It turns a broad interest into one practical decision model.",
        rating,
        clicked_at: null,
        created_at: "2026-09-03T12:00:00Z",
      });
    }

    if (url.pathname === "/api/personal/recommendations/generate") {
      return json(route, {});
    }

    if (url.pathname === "/api/personal/profile/delivery" && request.method() === "PUT") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      profilePayload = payload;
      return json(route, {
        preference_statement: "Rigorous ideas about systems, human judgment, and better decisions.",
        timezone: "America/Los_Angeles",
        cadence_days: [2, 5],
        delivery_hour: 9,
        recommendation_count: payload.recommendation_count,
        version: 4,
        updated_at: "2026-09-04T12:00:00Z",
      });
    }

    if (url.pathname === "/api/personal/profile/memory" && request.method() === "PUT") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      memoryPayload = payload;
      return json(route, {
        preference_statement: payload.preference_statement,
        timezone: "America/Los_Angeles",
        cadence_days: [2, 5],
        delivery_hour: 9,
        recommendation_count: 1,
        version: 5,
        updated_at: "2026-09-04T12:00:00Z",
      });
    }

    if (url.pathname === "/api/personal/profile") {
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

    if (url.pathname === "/api/personal/channels/resolve") {
      const submittedUrl = String(request.postDataJSON().url);
      if (submittedUrl.includes("missing")) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        return route.fulfill({ status: 404, json: { detail: "YouTube video was not found" }, headers: { "access-control-allow-origin": "*" } });
      }
      if (submittedUrl.includes("@ted")) {
        return json(route, {
          youtube_channel_id: "UCTED",
          name: "TED",
          url: "https://www.youtube.com/channel/UCTED",
          thumbnail_url: null,
          already_tracked: true,
          can_reactivate: false,
        });
      }
      return json(route, {
        youtube_channel_id: "UC123",
        name: "Practical Engineering",
        url: "https://www.youtube.com/channel/UC123",
        thumbnail_url: "https://images.example.test/channel.jpg",
        already_tracked: false,
        can_reactivate: false,
      });
    }

    if (/\/api\/personal\/channels\/[^/]+$/.test(url.pathname) && request.method() === "DELETE") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
    }

    if (url.pathname === "/api/personal/channels" && request.method() === "POST") {
      channelPayload = request.postDataJSON();
      return json(route, { id: "channel-3", name: "Practical Engineering", url: "https://www.youtube.com/channel/UC123", thumbnail_url: "https://images.example.test/channel.jpg", is_default: false });
    }

    if (url.pathname === "/api/personal/channels") {
      return json(route, [
        { id: "channel-1", name: "TED", url: "https://youtube.com/@ted", thumbnail_url: null, is_default: true },
        { id: "channel-2", name: "MIT OpenCourseWare", url: "https://youtube.com/@mitocw", thumbnail_url: null, is_default: false },
      ]);
    }

    if (url.pathname === "/api/personal/recommendations") {
      return json(route, [
        {
          id: "rec-1",
          title: "How to make hard choices",
          speaker: "Ada Reed",
          channel_name: "TED",
          thumbnail_url: "https://images.example.test/signal.jpg",
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
          thumbnail_url: "https://images.example.test/archive.jpg",
          duration_seconds: 840,
          rationale: "A concise framework for protecting focus without productivity theater.",
          rating: "up",
          clicked_at: null,
          created_at: "2026-09-02T12:00:00Z",
        },
      ]);
    }

    if (url.pathname === "/api/personal/account") return json(route, {id: "test-account", email: "beta@example.test", display_name: "Beta reader", telegram_connected: false, delivery_paused: false});
    if (url.pathname === "/api/personal/account/preferences") return json(route, []);
    return json(route, {});
  });
  return {
    feedbackId: () => feedbackId,
    profilePayload: () => profilePayload,
    memoryPayload: () => memoryPayload,
    channelPayload: () => channelPayload,
  };
}

test("renders personal recommendations and semantic feedback", async ({ page }) => {
  const captured = await mockPublicApi(page);
  await page.goto("/app");

  await expect(page.getByRole("heading", { name: /Your next/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How to make hard choices" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The architecture of attention" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Match Lab", exact: true })).toHaveAttribute("href", "/match");
  await expect(page.getByRole("link", { name: "Watch How to make hard choices on YouTube" })).toHaveAttribute("href", "/api/personal/r/rec-1");
  await expect(page.getByRole("heading", { name: "Signal quality" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Not useful" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Useful" }).first().click();
  await expect(page.getByRole("button", { name: "Useful" }).first()).toHaveAttribute("aria-pressed", "true");
  expect(captured.feedbackId()).toBe("rec-1");
});

test("saves delivery schedule and resolves a URL-only source", async ({ page }) => {
  const captured = await mockPublicApi(page);
  await page.goto("/app/settings");

  await expect(page.getByLabel("Delivery hour (local time)")).toHaveValue("9");
  await expect(page.getByLabel("Timezone")).toHaveValue("America/Los_Angeles");
  await expect(page.getByRole("button", { name: "Decrease picks" })).toBeDisabled();
  await expect(page.getByRole("status", { name: "1 pick" })).toBeVisible();
  await page.getByRole("button", { name: "Increase picks" }).click();
  await expect(page.getByRole("status", { name: "2 picks" })).toBeVisible();
  await page.getByRole("button", { name: "Save preferences" }).click();
  expect(captured.profilePayload()).toEqual({ cadence_days: [2, 5], recommendation_count: 2, timezone: "America/Los_Angeles", delivery_hour: 9 });

  const sourceUrl = "https://youtu.be/practical";
  await page.getByLabel("YouTube URL").fill(sourceUrl);
  await expect(page.getByText("Practical Engineering is ready to add.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open canonical channel" })).toBeVisible();
  await page.getByRole("button", { name: "Add source" }).click();
  expect(captured.channelPayload()).toEqual({ url: sourceUrl });
  await expect(page.getByRole("button", { name: "Remove Practical Engineering" })).toBeVisible();
});

test("saves preference memory with an optimistic version and no delivery fields", async ({ page }) => {
  const captured = await mockPublicApi(page);
  await page.goto("/app/settings");

  await page.getByRole("button", { name: "Shape memory" }).click();
  await page.getByLabel("Your interests and exclusions").fill("Systems thinking with practical evidence.");
  await page.getByRole("button", { name: "Save memory" }).click();

  expect(captured.memoryPayload()).toEqual({
    preference_statement: "Systems thinking with practical evidence.",
    expected_version: 4,
  });
  await expect(page.getByText("Preference memory saved.")).toBeVisible();
});

test("shows invalid, lookup failure, duplicate, and removable-default source states", async ({ page }) => {
  await mockPublicApi(page);
  await page.goto("/app/settings");
  const input = page.getByLabel("YouTube URL");

  await input.fill("https://example.com/not-youtube");
  await expect(page.getByText("Use a YouTube channel, handle, video, or youtu.be URL.")).toBeVisible();

  await input.fill("https://youtu.be/missing");
  await expect(page.getByText("Finding the channel behind this URL…")).toBeVisible();
  await expect(page.getByText("YouTube video was not found")).toBeVisible();

  await input.fill("https://youtube.com/@ted");
  await expect(page.getByText("TED is already tracked.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add source" })).toBeDisabled();

  await page.getByRole("button", { name: "Remove TED" }).click();
  await expect(page.getByRole("button", { name: "Remove TED" })).toHaveCount(0);
});

test("keeps the public page inside a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockPublicApi(page);
  await page.goto("/app/settings");
  const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "My feed", exact: true })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Match Lab", exact: true })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.inner);
});

test("keeps the review decision in reach and completes three mobile pairs", async ({ page }) => {
  const description = (
    "Streaming media gives us access to everything instantly, but at what cost? Music professor Tom " +
    "Rizzuto traces the history of physical media, including CDs, vinyl, bone music, and records pressed " +
    "onto discarded X-rays. He examines the near-loss of Nosferatu and argues that art should not live " +
    "only in the cloud. The talk gives viewers a practical way to think about access, ownership, and loss."
  ).padEnd(414, " Detail.");
  expect(description).toHaveLength(414);
  const cards = [1, 2, 3].map((number) => ({
    profile_id: `profile-${number}`,
    video_id: `video-${number}`,
    summary: number === 1
      ? "I run a book group and want thoughtful ideas about culture, memory, and how technology changes our relationship with art."
      : "I am planning a career change and want advice on finding work and building useful relationships. I do not need advice on maximizing social-media reach.",
    topics: number === 1 ? ["books", "reading", "culture", "community"] : ["career change", "networking", "employment"],
    title: number === 1
      ? "The Problem with Streaming | Tom Rizzuto | TED"
      : number === 2 ? "The Hidden Cost Of Not Posting Online | Joe Gannon | TEDxBlack Mountain" : `Candidate video ${number}`,
    description,
    thumbnail_url: "https://i.ytimg.com/vi/video-1/hqdefault.jpg",
  }));
  const submitted: Record<string, unknown>[] = [];
  let batchCompleted = 0;
  await page.route("**/api/match/annotations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/match/annotations/next") return json(route, cards[batchCompleted] ?? null);
    if (url.pathname === "/api/match/annotations" && request.method() === "POST") {
      submitted.push(request.postDataJSON());
      batchCompleted += 1;
      return json(route, { saved: true });
    }
    return json(route, {});
  });
  await page.route("**/_next/image?**", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  }));

  const viewports = [
    { width: 320, height: 800 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
  ];
  for (const [viewportIndex, viewport] of viewports.entries()) {
    batchCompleted = 0;
    await page.setViewportSize(viewport);
    if (viewportIndex === 0) {
      await page.goto("/match");
      await expect(page.getByRole("heading", { name: "Does this video fit?" })).toBeVisible();
      await page.getByRole("link", { name: "Review a match" }).click();
      await expect(page).toHaveURL(/\/match\/review$/);
    } else {
      await page.goto("/match/review");
    }
    await expect(page.getByText("Synthetic viewer profile.")).toBeVisible();
    await expect(page.getByText("Assistant-curated video.")).toBeVisible();
    await expect(page.getByText("Yes means a clear fit.")).toBeVisible();
    await expect(page.getByText("No means a clear mismatch.")).toBeVisible();
    await expect(page.getByText(/Unsure means the evidence is mixed/)).toBeVisible();

    const geometry = await page.locator(".match-choices").evaluate((choices) => ({
      documentTop: choices.getBoundingClientRect().top + window.scrollY,
      firstChoiceBottom: choices.querySelector("button")?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
      navigationTop: document.querySelector(".signal-mobile-nav")?.getBoundingClientRect().top ?? 0,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(geometry.documentTop).toBeLessThanOrEqual(viewport.height);
    expect(geometry.firstChoiceBottom).toBeLessThanOrEqual(geometry.navigationTop);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    await expect(page.getByRole("button", { name: "Yes", exact: true })).toBeVisible();

    const toggle = page.getByRole("button", { name: "Show full description" });
    await expect(toggle).toBeVisible();
    const collapsedHeight = await page.locator(".video-description").evaluate((description) => description.clientHeight);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    const expandedGeometry = await page.locator(".video-description").evaluate((description) => ({
      clientHeight: description.clientHeight,
      scrollHeight: description.scrollHeight,
    }));
    expect(expandedGeometry.clientHeight).toBeGreaterThan(collapsedHeight);
    expect(expandedGeometry.clientHeight).toBe(expandedGeometry.scrollHeight);
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Show full description" })).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: "Show full description" })).toBeFocused();

    for (let index = 0; index < cards.length; index += 1) {
      await page.getByRole("button", { name: index === 1 ? "Unsure" : "Yes", exact: true }).click();
      const reason = page.getByLabel("Reason Optional. It is useful for close calls.");
      await reason.fill(`Reason for pair ${index + 1}`);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.getByRole("button", { name: "Save judgment" }).click();
      if (index < cards.length - 1) {
        const viewer = page.getByRole("heading", { name: "Viewer" });
        await expect(viewer).toBeFocused();
        await expect(viewer).toBeInViewport();
        const nextPairControls = await page.getByRole("button", { name: "Yes", exact: true }).evaluate((firstChoice) => ({
          firstChoiceBottom: firstChoice.getBoundingClientRect().bottom,
          navigationTop: document.querySelector(".signal-mobile-nav")?.getBoundingClientRect().top ?? 0,
        }));
        expect(nextPairControls.firstChoiceBottom).toBeLessThanOrEqual(nextPairControls.navigationTop);
        await expect(page.getByRole("button", { name: "Yes", exact: true })).toHaveAttribute("aria-pressed", "false");
        await expect(page.getByRole("button", { name: "Unsure", exact: true })).toHaveAttribute("aria-pressed", "false");
        await expect(page.getByLabel("Reason Optional. It is useful for close calls.")).toHaveValue("");
        await expect(page.getByRole("button", { name: "Show full description" })).toHaveAttribute("aria-expanded", "false");
      }
    }
    await expect(page.getByRole("heading", { name: "No more pairs are available for you right now." })).toBeVisible();
  }

  expect(submitted).toHaveLength(9);
});

test("preserves the desktop review columns", async ({ page }) => {
  await page.route("**/api/match/annotations/next", (route) => json(route, {
    profile_id: "profile-desktop",
    video_id: "video-desktop",
    summary: "Wants careful explanations of decision systems.",
    topics: ["decisions"],
    title: "How judgment works",
    description: "A practical account of evidence and decisions.",
  }));
  await page.goto("/match/review");
  await expect(page.getByRole("heading", { name: "Viewer" })).toBeVisible();
  await expect(page.locator(".match-workspace, .match-profile, .match-video, .match-response")).toHaveCount(4);
  const geometry = await page.locator(".match-workspace, .match-profile, .match-video, .match-response").evaluateAll(([workspace, viewer, video, action]) => ({
    evidenceShare: (viewer.getBoundingClientRect().width + video.getBoundingClientRect().width) / workspace.getBoundingClientRect().width,
    actionShare: action.getBoundingClientRect().width / workspace.getBoundingClientRect().width,
    viewerTop: viewer.getBoundingClientRect().top,
    videoTop: video.getBoundingClientRect().top,
    actionTop: action.getBoundingClientRect().top,
  }));
  expect(geometry.evidenceShare).toBeGreaterThan(.74);
  expect(geometry.actionShare).toBeLessThan(.26);
  expect(Math.max(geometry.viewerTop, geometry.videoTop, geometry.actionTop) - Math.min(geometry.viewerTop, geometry.videoTop, geometry.actionTop)).toBeLessThanOrEqual(1);
});

test("uses plain loading and retry states and announces saving", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/match/annotations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/match/annotations/next") {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (attempts === 1) return route.fulfill({ status: 500, json: { detail: "Temporary failure" } });
      return json(route, {
        profile_id: "profile-recovered",
        video_id: "video-recovered",
        summary: "Wants practical evidence about decisions.",
        topics: ["evidence"],
        title: "A recovered pair",
        description: "A candidate available after retrying.",
      });
    }
    if (url.pathname === "/api/match/annotations" && request.method() === "POST") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return json(route, { saved: true });
    }
    return json(route, {});
  });

  await page.goto("/match/review");
  await expect(page.getByRole("heading", { name: "Loading the next pair." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The next pair could not be loaded." })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "A recovered pair" })).toBeVisible();
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await page.getByRole("button", { name: "Save judgment" }).click({ noWaitAfter: true });
  await expect(page.locator(".sr-only[role='status']")).toHaveText("Saving judgment.");
});

test("keeps a saved answer when loading the following pair fails", async ({ page }) => {
  let nextRequests = 0;
  let postRequests = 0;
  await page.route("**/api/match/annotations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/match/annotations/next") {
      nextRequests += 1;
      if (nextRequests === 2) return route.fulfill({ status: 500, json: { detail: "Temporary failure" } });
      return json(route, {
        profile_id: `profile-${nextRequests}`,
        video_id: `video-${nextRequests}`,
        summary: "Wants practical evidence about decisions.",
        topics: ["evidence"],
        title: nextRequests === 1 ? "The submitted pair" : "The pair after retry",
        description: "A candidate for a careful judgment.",
      });
    }
    if (url.pathname === "/api/match/annotations" && request.method() === "POST") {
      postRequests += 1;
      return json(route, { saved: true });
    }
    return json(route, {});
  });

  await page.goto("/match/review");
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await page.getByLabel("Reason Optional. It is useful for close calls.").fill("This answer should be saved once.");
  await page.getByRole("button", { name: "Save judgment" }).click();
  await expect(page.locator(".signal-notice.match-notice")).toHaveText("Answer saved.");
  await expect(page.locator(".match-notice[role='alert']")).toHaveText("Your answer was saved, but the next pair could not be loaded. Try again.");
  expect(postRequests).toBe(1);

  await page.getByRole("button", { name: "Try again" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "The pair after retry" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Viewer" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Yes", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByLabel("Reason Optional. It is useful for close calls.")).toHaveValue("");
  expect(postRequests).toBe(1);
});

test("keeps a debug assessment until explicit keyboard advancement", async ({ page }) => {
  let saved = false;
  await page.route("**/api/match/annotations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/match/annotations/next") {
      return json(route, saved ? null : {
        profile_id: "profile-debug",
        video_id: "video-debug",
        summary: "Wants careful explanations of decision systems.",
        topics: ["decisions"],
        title: "How judgment works",
        description: "A practical account of evidence and decisions.",
      });
    }
    if (url.pathname === "/api/match/annotations/stats") {
      return json(route, saved ? { completed: 1, remaining: 0 } : { completed: 0, remaining: 1 });
    }
    if (url.pathname === "/api/match/annotations" && request.method() === "POST") {
      saved = true;
      return json(route, {
        assessment: {
          predicted_fit: "yes",
          close_call: true,
          decision_summary: "Direct evidence makes this a useful close judgment call.",
        },
      });
    }
    return json(route, {});
  });

  await page.goto("/match/review");
  await expect(page.getByText("Model assessment · debug")).toHaveCount(0);
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await page.getByRole("button", { name: "Save judgment" }).click();
  await expect(page.getByRole("heading", { name: "Predicted fit: yes" })).toBeVisible();
  await expect(page.getByText(/Close call.*Direct evidence/)).toBeVisible();
  await page.waitForTimeout(3_600);
  await expect(page.getByRole("heading", { name: "Predicted fit: yes" })).toBeVisible();
  await page.getByRole("button", { name: "Next pair" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "No more pairs are available for you right now." })).toBeVisible();
});

test("replaces an unavailable pair after a 409 and clears its unsaved judgment", async ({ page }) => {
  let stalePairSubmitted = false;
  let annotationBody: Record<string, unknown> | null = null;
  await page.route("**/api/match/annotations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/match/annotations/next") {
      return json(route, stalePairSubmitted ? {
        profile_id: "profile-2",
        video_id: "video-2",
        summary: "Wants grounded explanations of complex systems.",
        topics: ["systems"],
        title: "A fresh pair to review",
        description: "A second candidate that is still available for judgment.",
      } : {
        profile_id: "profile-1",
        video_id: "video-1",
        summary: "Wants practical decision frameworks.",
        topics: ["judgment"],
        title: "The stale pair",
        description: "This candidate becomes unavailable before submission.",
      });
    }
    if (url.pathname === "/api/match/annotations" && request.method() === "POST") {
      annotationBody = request.postDataJSON();
      stalePairSubmitted = true;
      return route.fulfill({ status: 409, json: { detail: "Pair is unavailable" } });
    }
    return json(route, {});
  });

  await page.goto("/match/review");
  await expect(page.getByRole("heading", { name: "The stale pair" })).toBeVisible();
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await page.getByLabel("Reason Optional. It is useful for close calls.").fill("This rationale belongs only to the stale pair.");
  await page.getByRole("button", { name: "Save judgment" }).click();

  await expect(page.locator(".sr-only[role='status']")).toContainText("This pair is no longer available. Your answer was not saved. The next pair is ready.");
  await expect(page.locator(".match-notice")).toHaveText("This pair is no longer available; your answer was not saved.");
  await expect(page.getByRole("heading", { name: "A fresh pair to review" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Viewer" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Viewer" })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Yes", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByLabel("Reason Optional. It is useful for close calls.")).toHaveValue("");
  expect(annotationBody).toEqual({
    profile_id: "profile-1",
    video_id: "video-1",
    label: "yes",
    rationale: "This rationale belongs only to the stale pair.",
  });
});

test("preserves a judgment after a retryable 500 and resubmits the same payload", async ({ page }) => {
  const annotationBodies: Record<string, unknown>[] = [];
  let saved = false;
  await page.route("**/api/match/annotations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/match/annotations/next") {
      return json(route, saved ? null : {
        profile_id: "profile-retry",
        video_id: "video-retry",
        summary: "Wants evidence-led explanations.",
        topics: ["evidence"],
        title: "A judgment worth retrying",
        description: "The same candidate remains available after a temporary failure.",
      });
    }
    if (url.pathname === "/api/match/annotations" && request.method() === "POST") {
      annotationBodies.push(request.postDataJSON());
      if (annotationBodies.length === 1) {
        return route.fulfill({ status: 500, json: { detail: "Temporary failure" } });
      }
      saved = true;
      return json(route, { saved: true });
    }
    return json(route, {});
  });

  await page.goto("/match/review");
  await page.getByRole("button", { name: "No", exact: true }).click();
  const reason = page.getByLabel("Reason Optional. It is useful for close calls.");
  await reason.fill("The evidence does not support this viewer's stated interest.");
  await page.getByRole("button", { name: "Save judgment" }).click();

  await expect(page.locator(".match-notice[role='alert']")).toHaveText("Your answer was not saved. Try again.");
  await expect(page.getByRole("button", { name: "No", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(reason).toHaveValue("The evidence does not support this viewer's stated interest.");
  await page.getByRole("button", { name: "Save judgment" }).click();

  await expect(page.getByRole("heading", { name: "No more pairs are available for you right now." })).toBeVisible();
  expect(annotationBodies).toHaveLength(2);
  expect(annotationBodies[1]).toEqual(annotationBodies[0]);
});


test("public landing explains the beta and links to private sign-in without account requests", async ({ page }) => {
  let personalRequests = 0;
  await page.route("**/api/personal/**", route => { personalRequests++; return route.fulfill({status: 401,json:{detail:"Sign in"}}); });
  await page.goto("/");
  await expect(page.getByRole("heading", {name: "Your attention has better places to be."})).toBeVisible();
  await expect(page.getByText("Illustrative interface and copy. This is not a real recommendation.")).toBeVisible();
  await expect(page.getByRole("link", {name: "Build my finite feed"}).first()).toHaveAttribute("href", "/app");
  expect(personalRequests).toBe(0);
  await page.setViewportSize({width:320,height:800});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto("/app");
  await expect(page.getByRole("button", {name: "Continue with Google"})).toBeVisible();
});

test("keeps the same navigation and footer across public routes", async ({ page }) => {
  await page.route("**/api/personal/**", route => route.fulfill({status: 401, json: {detail: "Sign in"}}));
  const routes = ["/", "/privacy", "/app", "/match"];

  await page.setViewportSize({width: 1100, height: 800});
  for (const route of routes) {
    await page.goto(route);
    const primary = page.getByRole("navigation", {name: "Primary navigation"});
    await expect(primary.getByRole("link", {name: "My feed", exact: true})).toHaveAttribute("href", "/app");
    await expect(primary.getByRole("link", {name: "Match Lab", exact: true})).toHaveAttribute("href", "/match");
    await expect(primary.getByRole("link", {name: "Settings", exact: true})).toHaveAttribute("href", "/app/settings");
    const footer = page.getByRole("contentinfo");
    await expect(footer.getByRole("link", {name: "Privacy & your data"})).toHaveAttribute("href", "/privacy");
    await expect(footer.getByText("Private beta", {exact: true})).toBeVisible();
  }

  await page.setViewportSize({width: 320, height: 800});
  for (const route of routes) {
    await page.goto(route);
    const mobile = page.getByRole("navigation", {name: "Mobile navigation"});
    await expect(mobile.getByRole("link", {name: "My feed", exact: true})).toBeVisible();
    await expect(mobile.getByRole("link", {name: "Match Lab", exact: true})).toBeVisible();
    await expect(mobile.getByRole("link", {name: "Settings", exact: true})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
