"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { SignalShell } from "@/components/signal-shell";

type MatchCard = {
  profile_id: string;
  video_id: string;
  summary: string;
  topics: string[];
  title: string;
  description: string;
  thumbnail_url: string | null;
};

type Label = "yes" | "no" | "unsure";

const storageKey = "finite-feed-annotator-id";

export function MatchGame({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [annotatorId, setAnnotatorId] = useState("");
  const [card, setCard] = useState<MatchCard | null>(null);
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
      const cardResponse = await fetch(`${apiBaseUrl}/api/annotations/next?${query}`, { cache: "no-store" });
      if (!cardResponse.ok) throw new Error("The next pair could not be loaded. Try again.");
      const nextCard: MatchCard | null = await cardResponse.json();
      setCard(nextCard);
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
    <SignalShell className="match-page" mastheadTitle="Does this belong?">
      <main className="match-main">
        {notice && <p className="signal-notice match-notice" role="status">{notice}</p>}
        {error && <p className="signal-error match-notice" role="alert">{error}</p>}

        {card ? (
          <section className="match-workspace" aria-busy={busy} aria-label="Review a viewer and candidate video">
            <article className="match-profile">
              <header className="match-column-heading">
                <h2>Viewer</h2>
                <p>What this person wants to watch.</p>
              </header>
              <ul className="topic-list" aria-label="Viewer topics">
                {card.topics.map((topic) => <li key={topic}>{topic}</li>)}
              </ul>
              <p className="profile-summary">{card.summary}</p>
            </article>

            <article className="match-video">
              <header className="match-column-heading">
                <h2>Video</h2>
                <p>The candidate the system is considering.</p>
              </header>
              {card.thumbnail_url && (
                <Image
                  className="match-video-thumbnail"
                  src={card.thumbnail_url}
                  alt=""
                  width={640}
                  height={360}
                />
              )}
              <div className="match-video-copy">
                <h3>{card.title}</h3>
                <p className="video-description">{card.description}</p>
              </div>
            </article>

            <aside className="match-response" aria-labelledby="match-action-title">
              <h2 id="match-action-title">Action</h2>
              <p className="match-action-help">Would this person value this video? Choose the clearest answer.</p>
              <fieldset>
                <legend className="sr-only">Choose a judgment</legend>
                <div className="match-choices">
                  <button className="match-choice-yes" type="button" aria-pressed={selected === "yes"} onClick={() => setSelected("yes")} disabled={busy}>Yes</button>
                  <button className="match-choice-no" type="button" aria-pressed={selected === "no"} onClick={() => setSelected("no")} disabled={busy}>No</button>
                  <button className="match-choice-unsure" type="button" aria-pressed={selected === "unsure"} onClick={() => setSelected("unsure")} disabled={busy}>Unsure</button>
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
              <button className="match-save" data-state={busy ? "saving" : selected ? "ready" : "idle"} onClick={() => void submit()} disabled={busy || !selected}>
                {busy ? "Saving judgment…" : "Save judgment"}
              </button>
            </aside>
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
