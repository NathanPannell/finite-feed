import Link from "next/link";
import type { Metadata } from "next";
import { HomepageShowcase } from "@/components/homepage-showcase";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

const publicUrl = "https://finite-feed-rho.vercel.app";
const description = "Choose your YouTube sources, tell Finite Feed what you want to watch, and get video picks at your pace.";
const shareImage = { url: `${publicUrl}/share-image`, width: 1200, height: 630, alt: "Finite Feed showing one TED recommendation after sources and interests narrow into a chosen pick." };

export const metadata: Metadata = {
  title: "Finite Feed: Your attention has better places to be",
  description,
  alternates: { canonical: publicUrl },
  openGraph: { type: "website", url: publicUrl, siteName: "Finite Feed", title: "Finite Feed: Your attention has better places to be", description, images: [shareImage] },
  twitter: { card: "summary_large_image", title: "Finite Feed", description, images: [shareImage] },
};

export default function Home() {
  return <div className="landing">
    <a className="skip-link" href="#main">Skip to content</a>
    <SiteHeader active="home" marketing action={<Link className="nav-primary" href="/app">Build my feed</Link>} />
    <main id="main">
      <section className="landing-hero">
        <div className="landing-lead">
          <h1><span className="headline-line">Your attention{" "}</span><span className="headline-line headline-accent">has better{" "}</span><span className="headline-line">places to be.</span></h1>
          <p>Tell Finite Feed what you want to watch. Choose your YouTube channels, and get video picks on the dashboard or in Telegram when you want them.</p>
          <div className="landing-actions"><Link className="landing-cta" href="/app">Build my finite feed <span aria-hidden="true">→</span></Link><Link className="landing-secondary" href="/match">Rate a video match <span aria-hidden="true">→</span></Link></div>
          <p className="landing-note">Sign in with Google or email. Telegram delivery is optional.</p>
        </div>
        <HomepageShowcase />
      </section>
      <ul className="capability-strip" aria-label="Finite Feed capabilities"><li>Editable interests</li><li>Your YouTube sources</li><li>You choose how many</li><li>Dashboard or Telegram</li><li>Useful / not useful feedback</li></ul>
      <section id="how-it-works" className="landing-method" aria-labelledby="method">
        <div className="method-intro"><h2 id="method">Good picks.<br />Then you’re done.</h2><p>Choose how many picks you want and when they arrive.</p></div>
        <ol>
          <li><span className="method-ui method-ui-interests" aria-hidden="true"><b>Design</b><b>Behavior</b><b>Technology</b></span><div><h3>Write your interests.</h3><p>Name the subjects, questions, and kinds of videos you want. Add what you would rather skip.</p></div></li>
          <li><span className="method-ui method-ui-sources" aria-hidden="true"><b>TED</b><b>TEDx</b></span><div><h3>Choose your sources.</h3><p>Start with TED and TEDx, then add the YouTube channels you already trust.</p></div></li>
          <li><span className="method-ui method-ui-schedule" aria-hidden="true"><b>Tue</b><b>Fri</b><em>9:00</em></span><div><h3>Set your pace.</h3><p>Choose the days, time, timezone, and number of recommendations that fit your week.</p></div></li>
          <li><span className="method-ui method-ui-feedback" aria-hidden="true"><b>Useful</b><b>Not useful</b></span><div><h3>React and move on.</h3><p>Open a pick to see why it matched. Your feedback gives the next pick better context.</p></div></li>
        </ol>
      </section>
      <section className="landing-audience" aria-labelledby="audience-title">
        <div><h2 id="audience-title">You like YouTube.<br />You don’t need its home page.</h2></div>
        <div className="audience-copy"><p>You already know which channels are worth hearing from. The hard part is choosing one video without losing the rest of the evening to the feed.</p><p>Finite Feed makes that choice, shows why it fits, and stops.</p></div>
        <div className="finite-window" aria-hidden="true"><span>Your chosen</span><b>number of</b><strong>picks</strong><i /></div>
      </section>
      <section className="landing-control" aria-labelledby="control-title">
        <div className="control-statement"><span>What you want to watch</span><p>“Give me practical ideas about creativity, behavior, and technology. Skip broad motivation and trend recaps.”</p><b>Change your interests whenever you like.</b></div>
        <div><h2 id="control-title">See why it was picked.</h2><p>Your interests stay readable and editable. Each recommendation keeps its selection reason beside it, so you can judge the fit before you press play.</p><Link className="landing-text-link" href="/privacy">See how your data is handled <span aria-hidden="true">→</span></Link></div>
      </section>
      <section className="landing-close"><h2>A feed with<br />a finish line.</h2><div><p>Choose your channels, set your pace, and get your first pick.</p><Link className="landing-cta" href="/app">Build my finite feed <span aria-hidden="true">→</span></Link><Link className="landing-secondary" href="/match">Rate a match first</Link></div></section>
    </main>
    <SiteFooter />
  </div>;
}
