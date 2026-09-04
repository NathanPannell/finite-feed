"use client";

import { createAuthClient } from "@neondatabase/auth/next";

export const authClient = createAuthClient();

export async function getBearerToken() {
  const { data, error } = await authClient.token();
  if (error || !data?.token) throw new Error("Your Google session expired. Sign in again to continue.");
  return data.token;
}
