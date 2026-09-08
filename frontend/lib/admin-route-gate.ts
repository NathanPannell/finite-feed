export type AdminRouteDecision =
  | { kind: "allow" }
  | { kind: "deny" }
  | { kind: "redirect"; host: string };

export function adminRouteDecision(input: {
  appEnvironment?: string;
  nodeEnv?: string;
  vercelEnv?: string;
  vercelUrl?: string;
  requestHostname: string;
}): AdminRouteDecision {
  if (input.nodeEnv === "development" || input.nodeEnv === "test") {
    return { kind: "allow" };
  }
  if (input.vercelEnv === "development") {
    return { kind: "allow" };
  }

  const protectedAlias = input.vercelEnv === "production"
    || (input.vercelEnv === "preview" && input.appEnvironment === "staging");
  if (!protectedAlias) {
    if (input.vercelEnv === "preview" && input.appEnvironment !== "staging") return { kind: "allow" };
    return { kind: "deny" };
  }

  const deploymentHost = input.vercelUrl?.trim().toLowerCase();
  if (!deploymentHost) {
    return { kind: "deny" };
  }
  if (input.requestHostname.toLowerCase() === deploymentHost) {
    return { kind: "allow" };
  }
  return { kind: "redirect", host: deploymentHost };
}
