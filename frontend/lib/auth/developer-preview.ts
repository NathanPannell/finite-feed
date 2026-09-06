type PreviewEnvironment = Record<string, string | undefined>;

export function developerPreviewAuthEnabled(environment: PreviewEnvironment = process.env): boolean {
  return environment.VERCEL_ENV === "preview" && environment.DEVELOPER_PREVIEW_AUTH === "true";
}

export function isDeveloperPasswordRoute(path: string[]): boolean {
  const route = path.join("/");
  return route === "sign-in/email" || route === "sign-up/email";
}
