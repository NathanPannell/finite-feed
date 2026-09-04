"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";

import { authClient, getBearerToken } from "../lib/auth-client";

type MatchCard = {
  profile_id: string;
  video_id: string;
  summary: string;
  topics: string[];
  title: string;
  description: string;
};

type Stats = { completed: number; remaining: number };
type Label = "yes" | "no" | "unsure";
type Phase = "loading" | "choosing" | "explaining" | "submitting" | "empty" | "load-error";

const choices: { label: Label; title: string; detail: string }[] = [
  { label: "no", title: "No", detail: "Not a fit" },
  { label: "unsure", title: "Unsure", detail: "Too close" },
  { label: "yes", title: "Yes", detail: "Strong fit" },
];

export function MatchGame({ apiBaseUrl }: { apiBaseUrl: string }) {
  const session = authClient.useSession();
  const user = session.data?.user;
  const [card, setCard] = useState<MatchCard | null>(null);
  const [stats, setStats] = useState<Stats>({ completed: 0, remaining: 0 });
  const [selectedLabel, setSelectedLabel] = useState<Label | null>(null);
  const [rationale, setRationale] = useState("");
  const [phase, setPhase] = useState<Phase>("loading");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!apiBaseUrl) return;
    setPhase("loading");
    setNotice("");
    try {
      const token = await getBearerToken();
      const headers = { Authorization: `Bearer ${token}` };
      const [cardResponse, statsResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/api/annotations/next`, { cache: "no-store", headers }),
        fetch(`${apiBaseUrl}/api/annotations/stats`, { cache: "no-store", headers }),
      ]);
      if (!cardResponse.ok || !statsResponse.ok) throw new Error("Could not load the next match. Try again.");
      const nextCard = (await cardResponse.json()) as MatchCard | null;
      setCard(nextCard);
      setStats(await statsResponse.json());
      setSelectedLabel(null);
      setRationale("");
      setPhase(nextCard ? "choosing" : "empty");
    } catch (error) {
      setCard(null);
      setNotice(error instanceof Error ? error.message : "Could not load the next match. Try again.");
      setPhase("load-error");
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    if (!user) return;
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load, user]);

  function choose(label: Label) {
    if (phase === "submitting") return;
    setSelectedLabel(label);
    setPhase("explaining");
    setNotice("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!card || !selectedLabel || phase === "submitting") return;
    setPhase("submitting");
    setNotice("");
    try {
      const token = await getBearerToken();
      const response = await fetch(`${apiBaseUrl}/api/annotations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          profile_id: card.profile_id,
          video_id: card.video_id,
          label: selectedLabel,
          rationale: rationale.trim() || null,
        }),
      });
      if (!response.ok) throw new Error("Your answer was not saved. Try again.");
      setCard(null);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Your answer was not saved. Try again.");
      setPhase("explaining");
    }
  }

  async function signIn() {
    setNotice("");
    const { error } = await authClient.signIn.social({ provider: "google", callbackURL: "/match" });
    if (error) setNotice(error.message || "Google sign-in could not start. Try again.");
  }

  async function signOut() {
    await authClient.signOut();
    setCard(null);
    setSelectedLabel(null);
  }

  if (!apiBaseUrl) {
    return <main className="match-state">This page is waiting for its API connection.</main>;
  }

  if (session.isPending) {
    return <main className="match-state" aria-busy="true">Checking your sign-in…</main>;
  }

  if (!user) {
    return (
      <main className="match-signin">
        <Link href="/" className="match-brand" aria-label="Finite Feed home">
          <span className="brand-mark">F</span>
          <span>Finite Feed</span>
        </Link>
        <section>
          <span className="signin-orbit" aria-hidden="true">F</span>
          <h1>Match people with ideas.</h1>
          <p>Sign in once, then make fast calls that sharpen the recommendation engine.</p>
          <button className="google-signin" type="button" onClick={() => void signIn()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4h5.4a4.6 4.6 0 0 1-2 3v2.6h3.3c1.9-1.8 2.9-4.4 2.9-7.4Z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.4L15.4 17c-.9.6-2.1 1-3.4 1-2.6 0-4.9-1.8-5.7-4.2H3v2.7A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.3 13.8A6 6 0 0 1 6 12c0-.6.1-1.2.3-1.8V7.5H3A10 10 0 0 0 2 12c0 1.6.4 3.1 1 4.5l3.3-2.7Z"/><path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.9 1.5l2.9-2.8A9.7 9.7 0 0 0 12 2a10 10 0 0 0-9 5.5l3.3 2.7A6 6 0 0 1 12 6Z"/></svg>
            Continue with Google
          </button>
          {notice && <p className="match-notice" role="alert">{notice}</p>}
          <small>Your Google name and email are attached to each answer for auditability.</small>
        </section>
      </main>
    );
  }

  return (
    <main className="match-shell">
      <header className="match-header">
        <Link href="/" className="match-brand" aria-label="Finite Feed home">
          <span className="brand-mark">F</span>
          <span>Finite Feed</span>
        </Link>
        <p className="match-question">Would this viewer want this video?</p>
        <div className="match-account">
          <span><strong>{user.name}</strong><small>{stats.completed} reviewed</small></span>
          <button type="button" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>

      {notice && <p className="match-notice" role="alert">{notice}</p>}

      {card ? (
        <section className="match-workspace" aria-busy={phase === "loading" || phase === "submitting"}>
          <article className="match-profile">
            <p className="match-label">The viewer is into</p>
            <div className="topic-list" aria-label="Viewer topics">
              {card.topics.map((topic) => <span key={topic}>{topic}</span>)}
            </div>
            <p className="profile-summary">{card.summary}</p>
          </article>

          <article className="match-video">
            <p className="match-label">The video</p>
            <h1>{card.title}</h1>
            <p className="video-description">{card.description || "No useful description was provided."}</p>
          </article>

          <form className="match-response" onSubmit={submit}>
            <fieldset disabled={phase === "submitting"}>
              <legend>Your call</legend>
              <div className="match-actions">
                {choices.map((choice) => (
                  <button
                    className={`match-${choice.label}`}
                    data-selected={selectedLabel === choice.label || undefined}
                    type="button"
                    key={choice.label}
                    aria-pressed={selectedLabel === choice.label}
                    onClick={() => choose(choice.label)}
                  >
                    <strong>{choice.title}</strong>
                    <span>{choice.detail}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="match-reason-slot">
              {selectedLabel ? (
                <div className="match-reason-panel">
                  <label htmlFor="match-reason">Why? <span>Optional</span></label>
                  <textarea
                    id="match-reason"
                    value={rationale}
                    onChange={(event) => setRationale(event.target.value)}
                    maxLength={1000}
                    placeholder="Add a short reason if it helps."
                    disabled={phase === "submitting"}
                  />
                  <button type="submit" disabled={phase === "submitting"}>
                    {phase === "submitting" ? "Saving…" : "Save & next"}
                  </button>
                </div>
              ) : (
                <p className="match-prompt">Pick the closest answer. You can add a reason next.</p>
              )}
            </div>
            <p className="sr-only" aria-live="polite">
              {selectedLabel ? `${selectedLabel} selected. You can add an optional reason, then save.` : ""}
            </p>
          </form>
        </section>
      ) : phase === "loading" ? (
        <section className="match-empty" aria-busy="true"><p>Loading a fresh match…</p></section>
      ) : phase === "load-error" ? (
        <section className="match-empty"><h1>That match didn’t load.</h1><button type="button" onClick={() => void load()}>Try again</button></section>
      ) : (
        <section className="match-empty"><h1>You’re caught up.</h1><p>Thanks for making the feed smarter.</p></section>
      )}
    </main>
  );
}
