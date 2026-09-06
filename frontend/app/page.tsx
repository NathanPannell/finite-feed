import Link from "next/link";
import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

export const metadata: Metadata = {
  title: "Finite Feed: Your attention has better places to be",
  description: "Choose your YouTube sources, set your interests and schedule, then get one considered recommendation at a time.",
  alternates: { canonical: "https://finite-feed-rho.vercel.app" },
  openGraph: { title: "Finite Feed: Your attention has better places to be", description: "Your interests. Your sources. You choose the pace.", url: "https://finite-feed-rho.vercel.app", type: "website" },
  twitter: { card: "summary", title: "Finite Feed", description: "Your attention has better places to be." },
};

export default function Home() {
  return <div className="landing">
    <a className="skip-link" href="#main">Skip to content</a>
    <SiteHeader active="home" action={<Link className="nav-primary" href="/app">Build my feed</Link>} />
    <main id="main">
      <section className="landing-hero">
        <div className="landing-lead">
          <h1><span className="headline-line">Your attention{" "}</span><span className="headline-line headline-accent">has better{" "}</span><span className="headline-line">places to be.</span></h1>
          <p>Finite Feed learns what you care about, checks new uploads from the YouTube channels you choose, and sends your picks to Telegram on your schedule.</p>
          <div className="landing-actions"><Link className="landing-cta" href="/app">Build my finite feed <span aria-hidden="true">→</span></Link><Link className="landing-secondary" href="/match">Try the public Match Lab <span aria-hidden="true">→</span></Link></div>
          <p className="landing-note">Private beta. Google sign-in gets you started.</p>
        </div>
        <div className="recommendation-stage" aria-label="Illustrative Finite Feed recommendation">
          <div className="recommendation-shadow" aria-hidden="true" />
          <article className="landing-recommendation">
            <header><span>Sample recommendation</span><strong>Finite Feed / one pick</strong></header>
            <div className="recommendation-body">
              <div className="recommendation-art" aria-hidden="true"><span /><span /><span /></div>
              <div className="recommendation-main"><p>Ideas / human behavior</p><h2>Why some ideas stay with us</h2><span>Selected from a channel you chose</span></div>
            </div>
            <div className="recommendation-reason"><strong>Why this pick</strong><p>It connects your interest in practical psychology with your preference for clear, evidence-led talks.</p></div>
            <footer><span>Scheduled for Telegram</span><div aria-label="Example feedback controls"><b>Useful</b><b>Not useful</b></div></footer>
          </article>
          <p className="example-disclosure">Illustrative interface and copy. This is not a real recommendation.</p>
        </div>
      </section>
      <ul className="capability-strip" aria-label="Finite Feed capabilities"><li>Editable interests</li><li>Your YouTube sources</li><li>Telegram delivery</li><li>Reasons you can read</li><li>Useful / not useful feedback</li></ul>
      <section id="how-it-works" className="landing-method" aria-labelledby="method">
        <div className="method-intro"><h2 id="method">Good picks.<br />Then you’re done.</h2><p>Start with one, or choose how many fit. You set the boundaries before anything arrives.</p></div>
        <ol>
          <li><span className="method-mark" aria-hidden="true"><i /></span><div><h3>Say what you’re into.</h3><p>Write down the subjects, questions, and kinds of videos you want more of. Add what you’d rather skip.</p></div></li>
          <li><span className="method-mark method-mark-source" aria-hidden="true"><i /></span><div><h3>Pick the channels.</h3><p>Start with TED and TEDx, or add the YouTube sources you already trust.</p></div></li>
          <li><span className="method-mark method-mark-send" aria-hidden="true"><i /></span><div><h3>Choose your pace.</h3><p>Set the days, time, timezone, and number of recommendations that fit your week.</p></div></li>
          <li><span className="method-mark method-mark-learn" aria-hidden="true"><i /></span><div><h3>React and move on.</h3><p>See why the video matched. Mark it useful or not useful so the next pick has better context.</p></div></li>
        </ol>
      </section>
      <section className="landing-audience" aria-labelledby="audience-title">
        <div><h2 id="audience-title">You like YouTube.<br />You don’t need its home page.</h2></div>
        <div className="audience-copy"><p>You already know which channels are worth hearing from. The hard part is choosing one video without losing the rest of the evening to the feed.</p><p>Finite Feed gives that choice a beginning and an end. Open the recommendation, watch it if it fits, and get back to whatever deserved your attention in the first place.</p></div>
        <div className="finite-window" aria-hidden="true"><span>One</span><b>considered</b><strong>pick</strong><i /></div>
      </section>
      <section className="landing-control" aria-labelledby="control-title">
        <div className="control-statement"><span>Your preference memory</span><p>“Give me practical ideas about creativity, behavior, and technology. Skip broad motivation and trend recaps.”</p><b>Readable. Editable. Yours to shape.</b></div>
        <div><h2 id="control-title">The filter stays visible.</h2><p>Your interests are written in plain language. Every recommendation can include its reason, and your feedback becomes part of what Finite Feed knows about you.</p><Link className="landing-text-link" href="/privacy">See how your data is handled <span aria-hidden="true">→</span></Link></div>
      </section>
      <section className="landing-close"><h2>Ready for a feed<br />with a finish line?</h2><div><p>Choose what matters, set your pace, and let one recommendation be enough.</p><Link className="landing-cta" href="/app">Build my finite feed <span aria-hidden="true">→</span></Link><Link className="landing-secondary" href="/match">Try Match Lab first</Link></div></section>
    </main>
    <SiteFooter />
  </div>;
}
