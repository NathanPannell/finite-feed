import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Finite Feed — fewer things, better chosen",
  description: "A personal YouTube digest shaped by your interests. Choose your sources, receive thoughtful picks in Telegram, and leave the endless feed behind.",
  alternates: { canonical: "https://finite-feed-rho.vercel.app" },
  openGraph: { title: "Finite Feed — fewer things, better chosen", description: "Your interests. Your sources. One worthwhile watch at a time.", url: "https://finite-feed-rho.vercel.app", type: "website" },
  twitter: { card: "summary", title: "Finite Feed", description: "Fewer things. Better chosen." },
};

export default function Home() {
  return <div className="landing">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="landing-nav"><Link className="signal-wordmark" href="/"><span aria-hidden="true">F/</span>Finite Feed</Link><nav aria-label="Primary navigation"><Link href="/match">Try Match Lab</Link><Link href="/login">Sign in</Link></nav></header>
    <main id="main">
      <section className="landing-hero">
        <div className="landing-lead"><h1>Fewer things.<br /><span>Better chosen.</span></h1><p>A personal YouTube digest for the ideas you actually care about. Thoughtful picks from your sources, delivered to Telegram on your schedule.</p><Link className="landing-cta" href="/login">Shape your feed <span aria-hidden="true">↗</span></Link><p className="landing-note">Private beta · Sign in with Google to get started.</p></div>
        <figure className="landing-example"><figcaption>An illustrative recommendation</figcaption><div className="example-topic">Attention / Everyday ideas</div><h2>What makes an idea worth your time?</h2><p>You asked for practical ideas with a fresh perspective. This is the kind of focused, thoughtful talk your feed is designed to find.</p><div className="example-footer"><span>Your sources. Your interests.</span><strong>One worthwhile watch.</strong></div><p className="example-disclosure">Sample copy to show the format, not a real recommendation.</p></figure>
      </section>
      <section className="landing-method" aria-labelledby="method"><h2 id="method">An ending.<br />Not an endless feed.</h2><div><article><h3>Tell it what matters.</h3><p>Describe your interests and what to leave out. Your preferences stay readable and editable.</p></article><article><h3>Choose your sources.</h3><p>Start with our curated channels for science and ideas, or add your own YouTube sources. Finite Feed looks for a match in their titles and descriptions.</p></article><article><h3>Make each pick better.</h3><p>Get a short explanation with your recommendation. Mark it useful or not useful to help shape the next selection.</p></article></div></section>
      <section className="landing-close"><h2>Your attention<br />has better places to be.</h2><div><p>Start with your interests. Set a pace that works for you. Pause whenever you need.</p><Link className="landing-cta" href="/login">Create your personal feed <span aria-hidden="true">↗</span></Link><Link className="landing-secondary" href="/match">Or explore the public Match Lab</Link></div></section>
    </main>
    <footer className="landing-footer"><span>Finite Feed · Private beta</span><Link href="/privacy">Privacy & your data</Link><a href="https://github.com/NathanPannell/finite-feed/issues/new">Support / report a problem</a></footer>
  </div>;
}
