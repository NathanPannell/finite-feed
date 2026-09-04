"use client";

import { createAuthClient } from "@neondatabase/auth/next";

export const authClient = createAuthClient();

export async function getBearerToken() {
  const { data, error } = await authClient.token();
  const tokenData = data as { token?: string; session?: { token?: string } } | null;
  const token = tokenData?.token ?? tokenData?.session?.token;
  if (error || !token) throw new Error("Your Google session expired. Sign in again to continue.");
  return token;
}
