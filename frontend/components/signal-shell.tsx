import Link from "next/link";
import { ReactNode } from "react";

type SignalShellProps = {
  active?: "feed" | "match" | "admin" | "settings";
  children: ReactNode;
  className?: string;
  mastheadTitle?: string;
};

export function SignalShell({ active, children, className = "", mastheadTitle }: SignalShellProps) {
  return (
    <div className={`signal-shell ${className}`.trim()}>
      <header className="signal-masthead">
        <Link className="signal-wordmark" href="/" aria-label="Finite Feed home">
          <span aria-hidden="true">F/</span>
          Finite Feed
        </Link>
        {mastheadTitle ? (
          <h1 className="signal-masthead-title">{mastheadTitle}</h1>
        ) : (
          <p>An edited signal for a noisier internet.</p>
        )}
        <nav aria-label="Primary navigation">
          <Link href="/app" aria-current={active === "feed" ? "page" : undefined}>For you</Link>
          <Link href="/match" aria-current={active === "match" ? "page" : undefined}>Open Match Lab</Link>
          {active === "admin" ? <a href="/admin" aria-current="page">Control room</a> : <Link href="/app/settings" aria-current={active === "settings" ? "page" : undefined}>Settings</Link>}
        </nav>
      </header>
      {children}
      <nav className="signal-mobile-nav" aria-label="Mobile navigation">
        <Link href="/app" aria-current={active === "feed" ? "page" : undefined}>For you</Link>
        <Link href="/match" aria-current={active === "match" ? "page" : undefined}>Open Match Lab</Link>
        {active === "admin" ? <a href="/admin" aria-current="page">Control room</a> : <Link href="/app/settings" aria-current={active === "settings" ? "page" : undefined}>Settings</Link>}
      </nav>
    </div>
  );
}
