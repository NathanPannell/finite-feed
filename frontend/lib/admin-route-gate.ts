export type AdminRouteDecision =
  | { kind: "allow" }
  | { kind: "deny" }
  | { kind: "redirect"; host: string };

export function adminRouteDecision(input: {
  nodeEnv?: string;
  vercelEnv?: string;
  vercelUrl?: string;
  requestHostname: string;
}): AdminRouteDecision {
  if (input.nodeEnv === "development" || input.nodeEnv === "test") {
    return { kind: "allow" };
  }
  if (input.vercelEnv === "preview" || input.vercelEnv === "development") {
    return { kind: "allow" };
  }
  if (input.vercelEnv !== "production") {
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
