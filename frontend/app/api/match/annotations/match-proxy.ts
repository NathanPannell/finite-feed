const reviewerCookieName = "finite_feed_match_reviewer";
const maximumRequestBytes = 4_096;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const endpoints: Record<string, Record<string, string>> = {
  GET: {
    next: "/api/annotations/next",
    stats: "/api/annotations/stats",
  },
  POST: {
    "": "/api/annotations",
  },
};

export function matchApiBaseUrl(environment: Record<string, string | undefined> = process.env) {
  return environment.RAILWAY_API_BASE_URL;
}

function reviewerCookieValue(cookieHeader: string | null) {
  if (!cookieHeader) return null;
  const matches = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${reviewerCookieName}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(reviewerCookieName.length + 1);
  return /^[A-Za-z0-9._~-]{1,512}$/.test(value) ? value : null;
}

export function reviewerCookieHeader(cookieHeader: string | null) {
  const value = reviewerCookieValue(cookieHeader);
  return value ? `${reviewerCookieName}=${value}` : null;
}

export function rewriteReviewerSetCookie(setCookie: string) {
  const parts = setCookie.split(";").map((part) => part.trim()).filter(Boolean);
  const pair = parts.shift();
  if (!pair?.startsWith(`${reviewerCookieName}=`)) return null;
  const value = pair.slice(reviewerCookieName.length + 1);
  if (!/^[A-Za-z0-9._~-]{1,512}$/.test(value)) return null;

  const attributes: string[] = [];
  for (const part of parts) {
    const [rawName, ...rawValue] = part.split("=");
    const name = rawName.toLowerCase();
    const attributeValue = rawValue.join("=");
    if (name === "secure") attributes.push("Secure");
    if (name === "max-age" && /^\d{1,10}$/.test(attributeValue)) attributes.push(`Max-Age=${attributeValue}`);
    if (name === "expires" && !Number.isNaN(Date.parse(attributeValue))) attributes.push(`Expires=${attributeValue}`);
  }
  return [
    `${reviewerCookieName}=${value}`,
    ...attributes,
    "Path=/api/match/annotations",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

function setCookieValues(headers: Headers) {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = extended.getSetCookie?.() ?? [];
  if (values.length) return values;
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function endpointFor(method: string, path: string[]) {
  return endpoints[method]?.[path.join("/")] ?? null;
}

function upstreamUrl(apiBaseUrl: string, endpoint: string) {
  const configured = new URL(apiBaseUrl);
  if (!["http:", "https:"].includes(configured.protocol)) throw new Error("Unsupported API protocol");
  return new URL(endpoint, configured.origin);
}

export async function proxyMatchRequest(
  request: Request,
  path: string[],
  apiBaseUrl: string | undefined,
  fetcher: Fetcher = fetch,
) {
  const endpoint = endpointFor(request.method, path);
  if (!endpoint) return Response.json({ detail: "Match Lab endpoint not found" }, { status: 404 });
  if (!apiBaseUrl) return Response.json({ detail: "Match Lab API is not configured" }, { status: 503 });

  const upstreamHeaders = new Headers({ Accept: "application/json" });
  const reviewerCookie = reviewerCookieHeader(request.headers.get("cookie"));
  if (reviewerCookie) upstreamHeaders.set("Cookie", reviewerCookie);

  let body: string | undefined;
  if (request.method === "POST") {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return Response.json({ detail: "Match Lab submissions must be JSON" }, { status: 415 });
    }
    body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maximumRequestBytes) {
      return Response.json({ detail: "Match Lab submission is too large" }, { status: 413 });
    }
    upstreamHeaders.set("Content-Type", "application/json");
  }

  try {
    const upstream = await fetcher(upstreamUrl(apiBaseUrl, endpoint), {
      method: request.method,
      headers: upstreamHeaders,
      body,
      cache: "no-store",
      redirect: "manual",
    });
    const responseHeaders = new Headers({ "Cache-Control": "private, no-store" });
    const contentType = upstream.headers.get("content-type");
    if (contentType && /^(application\/json|text\/plain)(?:;|$)/i.test(contentType)) {
      responseHeaders.set("Content-Type", contentType);
    }
    for (const setCookie of setCookieValues(upstream.headers)) {
      const rewritten = rewriteReviewerSetCookie(setCookie);
      if (rewritten) responseHeaders.append("Set-Cookie", rewritten);
    }
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ detail: "Match Lab API could not be reached" }, { status: 502 });
  }
}
