import Link from "next/link";
import type { Metadata } from "next";
import { SignalShell } from "../../components/signal-shell";
import styles from "./page.module.css";

const publicUrl = "https://finite-feed-rho.vercel.app/match";
const description = "Compare a synthetic viewer profile with a video and help evaluate assistant-curated matches.";
const shareImage = {
  url: `${publicUrl}/share-image`,
  width: 1200,
  height: 630,
  alt: "Finite Feed Match Lab: Does this video fit this viewer? Yes, No, or Unsure.",
};

export const metadata: Metadata = {
  title: "Match Lab · Finite Feed",
  description,
  alternates: { canonical: publicUrl },
  openGraph: {
    type: "website",
    url: publicUrl,
    siteName: "Finite Feed",
    title: "Match Lab · Finite Feed",
    description,
    images: [shareImage],
  },
  twitter: {
    card: "summary_large_image",
    title: "Match Lab · Finite Feed",
    description,
    images: [shareImage],
  },
};

export default function MatchPage() {
  return (
    <SignalShell active="match" className="match-page" mastheadTitle="Does this belong?">
      <main id="main" tabIndex={-1} className="match-main">
        <section className={`match-intro ${styles.intro}`} aria-labelledby="match-intro-title">
          <div className="match-intro-lead">
            <h2 id="match-intro-title">Does this video fit?</h2>
            <p>Compare a synthetic viewer profile with a video. Choose whether the video fits what that viewer wants.</p>
            <Link className="signal-action" href="/match/review">Review a match</Link>
            <p className={styles.disclosure}>The pairs were selected by an AI assistant. Your answers provide the human review.</p>
          </div>
          <ol className="match-intro-steps">
            <li>
              <h3>Viewer</h3>
              <p>Read what this fictional viewer wants to watch, including what they want to avoid.</p>
            </li>
            <li>
              <h3>Video</h3>
              <p>Use the title and description to judge the fit.</p>
            </li>
            <li>
              <h3>Your judgment</h3>
              <p>Choose Yes for a clear fit, No for a clear mismatch, or Unsure when the evidence is mixed or incomplete. A reason is optional.</p>
            </li>
          </ol>
        </section>
      </main>
    </SignalShell>
  );
}
