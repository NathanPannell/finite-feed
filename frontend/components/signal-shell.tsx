import { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

type SignalShellProps = {
  active?: "feed" | "match" | "admin" | "settings";
  children: ReactNode;
  className?: string;
  mastheadTitle?: string;
};

export function SignalShell({ active, children, className = "", mastheadTitle }: SignalShellProps) {
  const title = mastheadTitle ?? ({ feed: "For you", match: "Match Lab", admin: "Control room", settings: "Settings" }[active ?? "feed"]);
  return (
    <div className={`signal-shell ${className}`.trim()}>
      <SiteHeader active={active} context={<h1 className="signal-masthead-title">{title}</h1>} />
      {children}
      <SiteFooter />
    </div>
  );
}
