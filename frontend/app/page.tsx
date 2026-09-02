import { FiniteFeedDashboard } from "@/components/finite-feed-dashboard";

export default function Home() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  return <FiniteFeedDashboard apiBaseUrl={apiBaseUrl} />;
}
