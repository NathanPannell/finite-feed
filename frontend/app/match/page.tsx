import { MatchGame } from "../../components/match-game";

export const metadata = {
  title: "Match Lab · Finite Feed",
  description: "Help judge which talks fit which viewers.",
};

export default function MatchPage() {
  return <MatchGame apiBaseUrl={process.env.NEXT_PUBLIC_API_BASE_URL ?? ""} />;
}
