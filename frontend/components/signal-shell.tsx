import Link from "next/link";
import { ReactNode } from "react";

type SignalShellProps = {
  active?: "feed" | "admin";
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
          <Link href="/" aria-current={active === "feed" ? "page" : undefined}>For you</Link>
          <a href="/admin" aria-current={active === "admin" ? "page" : undefined}>Control room</a>
        </nav>
      </header>
      {children}
      <nav className="signal-mobile-nav" aria-label="Mobile navigation">
        <Link href="/" aria-current={active === "feed" ? "page" : undefined}>For you</Link>
        <Link href="/#preferences">Preferences</Link>
        <a href="/admin" aria-current={active === "admin" ? "page" : undefined}>Control</a>
      </nav>
    </div>
  );
}
