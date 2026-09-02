import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Finite Feed",
  description: "A small full-stack application",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
