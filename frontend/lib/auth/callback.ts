export function finishOAuthRedirect(response: Response, requestUrl: string): Response {
  if (response.headers.has("location")) {
    response.headers.set("location", new URL("/app", requestUrl).href);
  }
  return response;
}
