"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { SignalShell } from "@/components/signal-shell";

type MatchCard = {
  profile_id: string;
  video_id: string;
  summary: string;
  topics: string[];
  title: string;
  description: string;
  thumbnail_url?: string | null;
};

type Label = "yes" | "no" | "unsure";
type Assessment = { predicted_fit: Label; close_call: boolean; decision_summary: string };
type AnnotationResult = { assessment: Assessment | null };

const matchApiBase = "/api/match/annotations";

export function MatchGame() {
  const [card, setCard] = useState<MatchCard | null>(null);
  const [selected, setSelected] = useState<Label | null>(null);
  const [rationale, setRationale] = useState("");
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
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
      const cardResponse = await fetch(`${matchApiBase}/next`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!cardResponse.ok) throw new Error("The next pair could not be loaded. Try again.");
      const nextCard: MatchCard | null = await cardResponse.json();
      setCard(nextCard);
      setSelected(null);
      setDescriptionExpanded(false);
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
      if (response.status === 409) {
        setCard(null);
        setSelected(null);
        setRationale("");
        setDescriptionExpanded(false);
        setAssessment(null);
        const nextCard = await load();
        if (nextCard !== undefined) {
          setNotice("This pair is no longer available; your answer was not saved.");
        }
        return;
      }
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
    <SignalShell active="match" className="match-page" mastheadTitle="Does this belong?">
      <main className="match-main">
        {notice && <p className="signal-notice match-notice" role="status">{notice}</p>}
        {error && <p className="signal-error match-notice" role="alert">{error}</p>}

        {assessment ? (
          <section className="match-assessment" role="status" aria-live="polite">
            <span>Model assessment · debug</span>
            <h2>Predicted fit: {assessment.predicted_fit}</h2>
            <p>{assessment.close_call ? "Close call" : "Clear call"} · {assessment.decision_summary}</p>
          </section>
        ) : card ? (
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
              {card.thumbnail_url ? (
                <Image
                  className="match-video-thumbnail"
                  src={card.thumbnail_url}
                  alt=""
                  width={640}
                  height={360}
                />
              ) : <div className="match-video-thumbnail match-video-thumbnail-fallback" aria-label="No video thumbnail">FF</div>}
              <div className="match-video-copy">
                <h3>{card.title}</h3>
                <p className={`video-description${descriptionExpanded ? " is-expanded" : ""}`}>{card.description}</p>
                {card.description.length > 420 && (
                  <button
                    className="video-description-toggle"
                    type="button"
                    aria-expanded={descriptionExpanded}
                    onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                  >
                    {descriptionExpanded ? "Show less" : "Show full description"}
                  </button>
                )}
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
