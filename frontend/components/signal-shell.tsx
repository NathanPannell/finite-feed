import { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

type SignalShellProps = {
  active?: "feed" | "match" | "admin" | "settings";
  children: ReactNode;
  className?: string;
  mastheadTitle?: string;
};

export function SignalShell({ active, children, className = "", mastheadTitle }: SignalShellProps) {
  return (
    <div className={`signal-shell ${className}`.trim()}>
      <SiteHeader active={active} context={mastheadTitle ? <h1 className="signal-masthead-title">{mastheadTitle}</h1> : undefined} />
      {children}
      <SiteFooter />
    </div>
  );
}
