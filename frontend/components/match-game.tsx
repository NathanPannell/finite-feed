"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
type Assessment = { predicted_fit: Label; close_call: boolean; decision_summary: string };
type AnnotationResult = { assessment: Assessment | null };

const matchApiBase = "/api/match/annotations";

export function MatchGame() {
  const [card, setCard] = useState<MatchCard | null>(null);
  const [stats, setStats] = useState<Stats>({ completed: 0, remaining: 0 });
  const [selected, setSelected] = useState<Label | null>(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const advanceTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // Fetch sequentially on first visit so the server-issued identity cookie from
      // the card request is present before stats are calculated.
      const cardResponse = await fetch(`${matchApiBase}/next`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const statsResponse = await fetch(`${matchApiBase}/stats`, {
        cache: "no-store",
        credentials: "same-origin",
      });
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
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(task);
      if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    };
  }, [load]);

  async function submit() {
    if (!card || !selected || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(matchApiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          profile_id: card.profile_id,
          video_id: card.video_id,
          label: selected,
          rationale: rationale.trim() || null,
        }),
      });
      if (!response.ok) throw new Error("Your answer was not saved. Try again.");
      let result: AnnotationResult = { assessment: null };
      try {
        result = await response.json() as AnnotationResult;
      } catch {
        // The judgment is already durable; assessment display is best effort.
      }
      setRationale("");
      setCard(null);
      if (result.assessment) {
        setAssessment(result.assessment);
        setBusy(false);
        setNotice("Answer saved.");
        advanceTimer.current = window.setTimeout(async () => {
          setAssessment(null);
          const nextCard = await load();
          if (nextCard !== undefined) {
            setNotice(nextCard ? "Answer saved. The next pair is ready." : "Answer saved. Every available pair has a judgment.");
          }
        }, 3500);
      } else {
        const nextCard = await load();
        if (nextCard !== undefined) {
          setNotice(nextCard ? "Answer saved. The next pair is ready." : "Answer saved. Every available pair has a judgment.");
        }
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Your answer was not saved. Try again.");
      setBusy(false);
    }
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

        {assessment ? (
          <section className="match-assessment" role="status" aria-live="polite">
            <span>Model assessment · debug</span>
            <h2>Predicted fit: {assessment.predicted_fit}</h2>
            <p>{assessment.close_call ? "Close call" : "Clear call"} · {assessment.decision_summary}</p>
          </section>
        ) : card ? (
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
            <button className="signal-action" onClick={() => void load()}>Try again</button>
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
