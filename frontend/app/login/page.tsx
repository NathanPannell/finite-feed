import type { Metadata } from "next";
import { SignInPrompt } from "@/components/account-controls";

export const metadata: Metadata = {
  title: "Sign in · Finite Feed",
  description: "Sign in to shape your personal Finite Feed.",
};

export default function LoginPage() {
  return <SignInPrompt />;
}
