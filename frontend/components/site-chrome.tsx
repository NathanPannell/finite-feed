import Link from "next/link";
import { ReactNode } from "react";

type SiteHeaderProps = {
  active?: "home" | "feed" | "match" | "admin" | "settings" | "privacy";
  action?: ReactNode;
  context?: ReactNode;
  showMatchLab?: boolean;
  marketing?: boolean;
};

function PrimaryLinks({ active, showMatchLab = true }: Pick<SiteHeaderProps, "active" | "showMatchLab">) {
  return <><Link href="/app" aria-current={active === "feed" ? "page" : undefined}>My feed</Link>{showMatchLab && <Link href="/match" aria-current={active === "match" ? "page" : undefined}>Match Lab</Link>}{active === "admin" ? <a href="/admin" aria-current="page">Control room</a> : <Link href="/settings" aria-current={active === "settings" ? "page" : undefined}>Settings</Link>}</>;
}

export function SiteHeader({ active, action, context, showMatchLab = true, marketing = false }: SiteHeaderProps) {
  return (
    <>
      {active !== "home" && <a className="skip-link" href="#main">Skip to content</a>}
      <header className={`signal-masthead ${marketing ? "marketing-masthead" : ""}`}>
        <Link className="signal-wordmark" href="/" aria-label="Finite Feed home" aria-current={active === "home" ? "page" : undefined}>
          <span aria-hidden="true">F/</span>
          Finite Feed
        </Link>
        <div className={`signal-masthead-context ${context ? "signal-masthead-context-title" : "signal-masthead-context-tagline"}`}>{context ?? <p>Your attention, better spent.</p>}</div>
        <nav aria-label="Primary navigation">{marketing ? <><a href="#how-it-works">How it works</a>{showMatchLab && <Link href="/match">Rate a match</Link>}</> : <PrimaryLinks active={active} showMatchLab={showMatchLab} />}{action}</nav>
      </header>
      {!marketing && <nav className="signal-mobile-nav" aria-label="Mobile navigation"><PrimaryLinks active={active} showMatchLab={showMatchLab} /></nav>}
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link className="site-footer-mark" href="/" aria-label="Finite Feed home"><span aria-hidden="true">F/</span>Finite Feed</Link>
      <p>YouTube picks for the time you have.</p>
      <nav aria-label="Footer navigation">
        <Link href="/privacy">Privacy &amp; your data</Link>
        <Link href="/privacy#help">Support</Link>
      </nav>
      <span>Built for a finite watchlist</span>
    </footer>
  );
}
