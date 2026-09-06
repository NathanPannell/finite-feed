import type { Metadata } from "next";
import { FiniteFeedDashboard } from "@/components/finite-feed-dashboard";

export const metadata: Metadata = {
  title: "Settings · Finite Feed",
  description: "Tune your interests, sources, delivery, and account.",
};

export default function SettingsPage() {
  return <FiniteFeedDashboard apiBaseUrl="/api/personal" settings />;
}
