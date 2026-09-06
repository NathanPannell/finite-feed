import type { Metadata } from "next";
import { OnboardingFlow } from "@/components/onboarding-flow";

export const metadata: Metadata = {
  title: "Shape your feed · Finite Feed",
  description: "Tell Finite Feed what is worth your attention and choose a delivery rhythm.",
};

export default function OnboardingPage() {
  return <OnboardingFlow />;
}
