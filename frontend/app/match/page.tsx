import Link from "next/link";
import { SignalShell } from "../../components/signal-shell";

export const metadata = {
  title: "Match Lab · Finite Feed",
  description: "Help judge which talks fit which viewers.",
};

export default function MatchPage() {
  return (
    <SignalShell className="match-page" mastheadTitle="Does this belong?">
      <main className="match-main">
        <section className="match-intro" aria-labelledby="match-intro-title">
          <div className="match-intro-lead">
            <h2 id="match-intro-title">Make one clear call.</h2>
            <p>Match Lab improves Finite Feed by comparing what a viewer wants with one candidate video. Each review takes about a minute.</p>
            <Link className="signal-action" href="/match/review">OK, let&apos;s begin</Link>
          </div>
          <ol className="match-intro-steps">
            <li>
              <h3>Viewer</h3>
              <p>Read the topics and short summary of what this person values.</p>
            </li>
            <li>
              <h3>Video</h3>
              <p>Review the candidate&apos;s thumbnail, title, and description.</p>
            </li>
            <li>
              <h3>Action</h3>
              <p>Choose Yes, No, or Unsure. Add a reason when it explains a close call.</p>
            </li>
          </ol>
        </section>
      </main>
    </SignalShell>
  );
}
