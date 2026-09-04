"use client";

import { useCallback, useEffect, useState } from "react";
import { SignalShell } from "@/components/signal-shell";

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

const storageKey = "finite-feed-annotator-id";

export function MatchGame({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [annotatorId, setAnnotatorId] = useState("");
  const [card, setCard] = useState<MatchCard | null>(null);
  const [stats, setStats] = useState<Stats>({ completed: 0, remaining: 0 });
  const [selected, setSelected] = useState<Label | null>(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (id: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const query = new URLSearchParams({ annotator_id: id });
      const [cardResponse, statsResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/api/annotations/next?${query}`, { cache: "no-store" }),
        fetch(`${apiBaseUrl}/api/annotations/stats?${query}`, { cache: "no-store" }),
      ]);
      if (!cardResponse.ok || !statsResponse.ok) throw new Error("The next pair could not be loaded. Try again.");
      const nextCard: MatchCard | null = await cardResponse.json();
      setCard(nextCard);
      setStats(await statsResponse.json());
      setSelected(null);
      return nextCard;
    } catch (error) {
      setError(error instanceof Error ? error.message : "The next pair could not be loaded. Try again.");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    if (!apiBaseUrl) return;
    const task = window.setTimeout(() => {
      let id = window.localStorage.getItem(storageKey);
      if (!id) {
        id = window.crypto.randomUUID();
        window.localStorage.setItem(storageKey, id);
      }
      setAnnotatorId(id);
      void load(id);
    }, 0);
    return () => window.clearTimeout(task);
  }, [apiBaseUrl, load]);

  async function submit() {
    if (!card || !annotatorId || !selected || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          annotator_id: annotatorId,
          profile_id: card.profile_id,
          video_id: card.video_id,
          label: selected,
          rationale: rationale.trim() || null,
        }),
      });
      if (!response.ok) throw new Error("Your answer was not saved. Try again.");
      setRationale("");
      setCard(null);
      const nextCard = await load(annotatorId);
      if (nextCard !== undefined) {
        setNotice(nextCard ? "Answer saved. The next pair is ready." : "Answer saved. Every available pair has a judgment.");
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Your answer was not saved. Try again.");
      setBusy(false);
    }
  }

  if (!apiBaseUrl) {
    return <main className="match-state">This page is waiting for its API connection.</main>;
  }

  return (
    <SignalShell className="match-page">
      <main className="match-main">
        <header className="match-intro">
          <h1>Does this<br /><span>belong?</span></h1>
          <div className="match-progress" aria-live="polite">
            <strong>{stats.completed}</strong>
            <span>reviewed</span>
            <i aria-hidden="true" />
            <strong>{stats.remaining}</strong>
            <span>left</span>
          </div>
        </header>

        {notice && <p className="signal-notice match-notice" role="status">{notice}</p>}
        {error && <p className="signal-error match-notice" role="alert">{error}</p>}

        {card ? (
          <section className="match-workspace" aria-busy={busy} aria-labelledby="match-question">
            <div className="match-comparison">
              <article className="match-profile">
                <h2>Viewer</h2>
                <p className="profile-summary">{card.summary}</p>
                <ul className="topic-list" aria-label="Viewer topics">
                  {card.topics.map((topic) => <li key={topic}>{topic}</li>)}
                </ul>
              </article>

              <article className="match-video">
                <h2>Candidate video</h2>
                <h3 id="match-question">{card.title}</h3>
                <p className="video-description">{card.description}</p>
              </article>
            </div>

            <div className="match-response">
              <fieldset>
                <legend>Choose the fit</legend>
                <div className="match-choices">
                  <button type="button" aria-pressed={selected === "no"} onClick={() => setSelected("no")} disabled={busy}>No</button>
                  <button type="button" aria-pressed={selected === "unsure"} onClick={() => setSelected("unsure")} disabled={busy}>Unsure</button>
                  <button type="button" aria-pressed={selected === "yes"} onClick={() => setSelected("yes")} disabled={busy}>Yes</button>
                </div>
              </fieldset>
              <label htmlFor="match-reason">Reason <span>Optional, but useful when it is close.</span></label>
              <textarea
                id="match-reason"
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
                maxLength={1000}
                placeholder="What made the fit clear?"
              />
              <button className="match-save" onClick={() => void submit()} disabled={busy || !selected}>
                {busy ? "Saving…" : "Save judgment"}
              </button>
            </div>
          </section>
        ) : busy ? (
          <section className="signal-empty match-empty" aria-live="polite">
            <h2>Loading the next pair.</h2>
            <p>Keeping the comparison clean and anonymous.</p>
          </section>
        ) : error ? (
          <section className="signal-empty match-empty">
            <h2>The lab lost its signal.</h2>
            <p>Retry the same anonymous session; no judgment has been lost.</p>
            <button className="signal-action" onClick={() => void load(annotatorId)}>Try again</button>
          </section>
        ) : (
          <section className="signal-empty match-empty">
            <h2>You’re caught up.</h2>
            <p>Every available pair has a judgment. Thank you.</p>
          </section>
        )}
      </main>
    </SignalShell>
  );
}
