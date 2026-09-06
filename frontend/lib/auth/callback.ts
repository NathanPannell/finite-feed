export function finishOAuthRedirect(response: Response, requestUrl: string): Response {
  if (response.headers.has("location")) {
    const location = new URL(response.headers.get("location")!, requestUrl);
    const destination = location.pathname.includes("sign-in") || location.pathname === "/login" ? "/login" : "/onboarding";
    response.headers.set("location", new URL(destination, requestUrl).href);
  }
  return response;
}
