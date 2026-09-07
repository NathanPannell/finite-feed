"use client";

import Image from "next/image";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const [descriptionClipped, setDescriptionClipped] = useState(false);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [liveMessage, setLiveMessage] = useState("Loading the next pair.");
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const viewerHeadingRef = useRef<HTMLHeadingElement>(null);
  const assessmentHeadingRef = useRef<HTMLHeadingElement>(null);
  const emptyHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusTarget = useRef<"pair" | "assessment" | null>(null);

  const load = useCallback(async ({ afterSaved = false }: { afterSaved?: boolean } = {}) => {
    setBusy(true);
    setError("");
    setNotice(afterSaved ? "Answer saved." : "");
    setAssessment(null);
    setLiveMessage(afterSaved ? "Answer saved. Loading the next pair." : "Loading the next pair.");
    try {
      const cardResponse = await fetch(`${matchApiBase}/next`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!cardResponse.ok) throw new Error("The next pair could not be loaded. Try again.");
      const nextCard: MatchCard | null = await cardResponse.json();
      setCard(nextCard);
      setSelected(null);
      setRationale("");
      setDescriptionExpanded(false);
      setDescriptionClipped(false);
      setLiveMessage(nextCard ? "The next pair is ready." : "No more pairs are available for you right now.");
      return nextCard;
    } catch (loadError) {
      const loadMessage = loadError instanceof Error ? loadError.message : "The next pair could not be loaded. Try again.";
      setError(afterSaved ? `Your answer was saved, but the next pair could not be loaded. Try again.` : loadMessage);
      setLiveMessage("");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  useLayoutEffect(() => {
    if (!focusTarget.current) return;
    let target: HTMLElement | null = null;
    if (focusTarget.current === "assessment" && assessment) {
      target = assessmentHeadingRef.current;
    } else if (focusTarget.current === "pair" && card) {
      target = viewerHeadingRef.current;
    } else if (focusTarget.current === "pair" && !busy && !card && !assessment && !error) {
      target = emptyHeadingRef.current;
    }
    if (!target) return;
    const focusElement = target;
    focusTarget.current = null;
    const frame = window.requestAnimationFrame(() => {
      focusElement.focus({ preventScroll: true });
      const top = window.scrollY + focusElement.getBoundingClientRect().top - 12;
      window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [assessment, busy, card, error]);

  useLayoutEffect(() => {
    const description = descriptionRef.current;
    if (!description || descriptionExpanded) return;

    let active = true;
    const measure = () => {
      if (!active) return;
      setDescriptionClipped(description.scrollHeight > description.clientHeight + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(description);
    measure();
    void document.fonts?.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [card, descriptionExpanded]);

  async function loadAndFocus(afterSaved = false) {
    focusTarget.current = "pair";
    return load({ afterSaved });
  }

  async function submit() {
    if (!card || !selected || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setLiveMessage("Saving judgment.");
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
        const nextCard = await loadAndFocus();
        if (nextCard !== undefined) {
          setNotice("This pair is no longer available; your answer was not saved.");
          setLiveMessage(nextCard
            ? "This pair is no longer available. Your answer was not saved. The next pair is ready."
            : "This pair is no longer available. Your answer was not saved. No more pairs are available for you right now.");
        }
        return;
      }
      if (!response.ok) throw new Error("Your answer was not saved. Try again.");
      let result: AnnotationResult = { assessment: null };
      try {
        result = await response.json() as AnnotationResult;
      } catch {
        // The judgment is already saved. The optional debug assessment is best effort.
      }
      setRationale("");
      setSelected(null);
      setDescriptionExpanded(false);
      setCard(null);
      if (result.assessment) {
        focusTarget.current = "assessment";
        setAssessment(result.assessment);
        setBusy(false);
        setNotice("Answer saved.");
        setLiveMessage("Answer saved. Model assessment is ready.");
      } else {
        const nextCard = await loadAndFocus(true);
        if (nextCard !== undefined) {
          const message = nextCard
            ? "Answer saved. The next pair is ready."
            : "Answer saved. No more pairs are available for you right now.";
          setNotice(message);
          setLiveMessage(message);
        }
      }
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Your answer was not saved. Try again.";
      setError(message);
      setLiveMessage("");
      setBusy(false);
    }
  }

  async function advanceAfterAssessment() {
    await loadAndFocus();
  }

  return (
    <SignalShell active="match" className="match-page" mastheadTitle="Does this belong?">
      <main id="main" tabIndex={-1} className="match-main">
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveMessage}</p>
        {notice && <p className="signal-notice match-notice">{notice}</p>}
        {error && <p className="signal-error match-notice" role="alert">{error}</p>}

        {assessment ? (
          <section className="match-assessment" aria-labelledby="match-assessment-title">
            <span>Model assessment · debug</span>
            <h2 id="match-assessment-title" ref={assessmentHeadingRef} tabIndex={-1}>Predicted fit: {assessment.predicted_fit}</h2>
            <p>{assessment.close_call ? "Close call" : "Clear call"} · {assessment.decision_summary}</p>
            <button className="signal-action match-assessment-next" type="button" onClick={() => void advanceAfterAssessment()} disabled={busy}>
              {busy ? "Loading..." : "Next pair"}
            </button>
          </section>
        ) : card ? (
          <section className="match-workspace" aria-busy={busy} aria-label="Review a synthetic viewer and candidate video">
            <article className="match-profile">
              <header className="match-column-heading">
                <h2 ref={viewerHeadingRef} tabIndex={-1}>Viewer</h2>
                <p>Synthetic viewer profile.</p>
              </header>
              <ul className="topic-list" aria-label="Viewer topics">
                {card.topics.map((topic) => <li key={topic}>{topic}</li>)}
              </ul>
              <p className="profile-summary">{card.summary}</p>
            </article>

            <article className="match-video">
              <header className="match-column-heading">
                <h2>Video</h2>
                <p>Assistant-curated video.</p>
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
                <p ref={descriptionRef} className={`video-description${descriptionExpanded ? " is-expanded" : ""}`}>{card.description}</p>
                {(descriptionClipped || descriptionExpanded) && (
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
              <p className="match-action-help">Would this viewer value this video?</p>
              <fieldset>
                <legend className="sr-only">Your judgment</legend>
                <div className="match-choices">
                  <div className="match-choice-row">
                    <button className="match-choice-yes" type="button" aria-pressed={selected === "yes"} aria-describedby="match-yes-definition" onClick={() => setSelected("yes")} disabled={busy}>Yes</button>
                    <p id="match-yes-definition"><strong>Yes</strong> means a clear fit.</p>
                  </div>
                  <div className="match-choice-row">
                    <button className="match-choice-no" type="button" aria-pressed={selected === "no"} aria-describedby="match-no-definition" onClick={() => setSelected("no")} disabled={busy}>No</button>
                    <p id="match-no-definition"><strong>No</strong> means a clear mismatch.</p>
                  </div>
                  <div className="match-choice-row">
                    <button className="match-choice-unsure" type="button" aria-pressed={selected === "unsure"} aria-describedby="match-unsure-definition" onClick={() => setSelected("unsure")} disabled={busy}>Unsure</button>
                    <p id="match-unsure-definition"><strong>Unsure</strong> means the evidence is mixed or the title and description do not provide enough information.</p>
                  </div>
                </div>
              </fieldset>
              <label htmlFor="match-reason">Reason <span>Optional. It is useful for close calls.</span></label>
              <textarea
                id="match-reason"
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
                maxLength={1000}
                placeholder="What made the fit clear or unclear?"
              />
              <button className="match-save" data-state={busy ? "saving" : selected ? "ready" : "idle"} onClick={() => void submit()} disabled={busy || !selected}>
                {busy ? "Saving judgment..." : "Save judgment"}
              </button>
            </aside>
          </section>
        ) : busy ? (
          <section className="signal-empty match-empty">
            <h2>Loading the next pair.</h2>
            <p>This may take a moment.</p>
          </section>
        ) : error ? (
          <section className="signal-empty match-empty">
            <h2>The next pair could not be loaded.</h2>
            <p>Try again to continue this review session.</p>
            <button className="signal-action" onClick={() => void loadAndFocus()}>Try again</button>
          </section>
        ) : (
          <section className="signal-empty match-empty">
            <h2 ref={emptyHeadingRef} tabIndex={-1}>No more pairs are available for you right now.</h2>
            <p>Thank you for reviewing these matches.</p>
          </section>
        )}
      </main>
    </SignalShell>
  );
}
