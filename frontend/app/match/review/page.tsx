import { MatchGame } from "../../../components/match-game";

export const metadata = {
  title: "Review match · Finite Feed",
  description: "Judge whether one candidate video fits one viewer.",
};

export default function MatchReviewPage() {
  return <MatchGame apiBaseUrl={process.env.NEXT_PUBLIC_API_BASE_URL ?? ""} />;
}
