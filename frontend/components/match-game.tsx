"use client";

import { useCallback, useEffect, useState } from "react";

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
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const query = new URLSearchParams({ annotator_id: id });
      const [cardResponse, statsResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/api/annotations/next?${query}`, { cache: "no-store" }),
        fetch(`${apiBaseUrl}/api/annotations/stats?${query}`, { cache: "no-store" }),
      ]);
      if (!cardResponse.ok || !statsResponse.ok) throw new Error("Could not load the next pair.");
      setCard(await cardResponse.json());
      setStats(await statsResponse.json());
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load the next pair.");
    } finally {
      setBusy(false);
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    if (!apiBaseUrl) return;
    let id = window.localStorage.getItem(storageKey);
    if (!id) {
      id = window.crypto.randomUUID();
      window.localStorage.setItem(storageKey, id);
    }
    setAnnotatorId(id);
    void load(id);
  }, [apiBaseUrl, load]);

  async function submit(label: Label) {
    if (!card || !annotatorId || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          annotator_id: annotatorId,
          profile_id: card.profile_id,
          video_id: card.video_id,
          label,
          rationale: rationale.trim() || null,
        }),
      });
      if (!response.ok) throw new Error("Your answer was not saved.");
      setRationale("");
      await load(annotatorId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Your answer was not saved.");
      setBusy(false);
    }
  }

  if (!apiBaseUrl) {
    return <main className="match-state">This page is waiting for its API connection.</main>;
  }

  return (
    <main className="match-shell">
      <header className="match-header">
        <a href="/" className="match-brand" aria-label="Finite Feed home">
          <span className="brand-mark">F</span>
          <span>Finite Feed</span>
        </a>
        <div className="match-progress" aria-live="polite">
          <strong>{stats.completed}</strong> reviewed
          {stats.remaining > 0 && <span> · {stats.remaining} available</span>}
        </div>
      </header>

      <section className="match-intro">
        <p className="kicker">Match lab</p>
        <h1>Would this person want this video?</h1>
        <p>Judge the content fit. There are no trick answers.</p>
      </section>

      {notice && <p className="match-notice" role="alert">{notice}</p>}

      {card ? (
        <section className="match-workspace" aria-busy={busy}>
          <article className="match-profile">
            <p className="match-label">Viewer</p>
            <div className="topic-list" aria-label="Viewer topics">
              {card.topics.map((topic) => <span key={topic}>{topic}</span>)}
            </div>
            <p className="profile-summary">{card.summary}</p>
          </article>

          <article className="match-video">
            <p className="match-label">Video</p>
            <h2>{card.title}</h2>
            <p className="video-description">{card.description}</p>
          </article>

          <div className="match-response">
            <label htmlFor="match-reason">Why? <span>Optional</span></label>
            <textarea
              id="match-reason"
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              maxLength={1000}
              placeholder="A short reason helps when the answer is close."
            />
            <div className="match-actions">
              <button className="match-no" onClick={() => void submit("no")} disabled={busy}>No</button>
              <button className="match-unsure" onClick={() => void submit("unsure")} disabled={busy}>Unsure</button>
              <button className="match-yes" onClick={() => void submit("yes")} disabled={busy}>Yes</button>
            </div>
          </div>
        </section>
      ) : busy ? (
        <section className="match-empty"><p>Loading a pair…</p></section>
      ) : (
        <section className="match-empty">
          <h2>You’re caught up.</h2>
          <p>Thanks for helping sharpen the recommendations.</p>
        </section>
      )}
    </main>
  );
}
