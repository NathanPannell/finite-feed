"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Option = { value: string; label: string };
type Question = { id: number; prompt: string; options: Option[] };
type Delivery = { timezone: string; cadence_days: number[]; delivery_hour: number; recommendation_count: number };
type OnboardingState = {
  status: "not_started" | "in_progress" | "completed";
  current_step: string;
  questions: Question[];
  answers: Record<string, string>;
  open_response?: string | null;
  draft_profile?: string | null;
  delivery?: Delivery | null;
  telegram_connected: boolean;
};

const fallbackQuestions: Question[] = [
  { id: 1, prompt: "What are you most interested in?", options: [
    { value: "technology_ai", label: "Technology & AI" }, { value: "business_work", label: "Business & work" },
    { value: "science_nature", label: "Science & nature" }, { value: "culture_society", label: "Culture & society" },
    { value: "mind_behavior", label: "Mind & behavior" }, { value: "health_wellbeing", label: "Health & wellbeing" },
  ] },
  { id: 2, prompt: "What do you want a good recommendation to give you?", options: [
    { value: "practical_skills", label: "Practical skills" }, { value: "fresh_perspectives", label: "Fresh perspectives" },
    { value: "deep_understanding", label: "Deeper understanding" }, { value: "inspiring_stories", label: "Inspiring stories" },
  ] },
  { id: 3, prompt: "How should it feel to watch?", options: [
    { value: "concise_focused", label: "Concise & focused" }, { value: "detailed_rigorous", label: "Detailed & rigorous" },
    { value: "surprising_provocative", label: "Surprising & provocative" }, { value: "accessible_conversational", label: "Accessible & conversational" },
  ] },
];
const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function stepFor(state: OnboardingState): number {
  const unanswered = [1, 2, 3].find((id) => !state.answers?.[String(id)]);
  if (unanswered) return unanswered - 1;
  if (!state.open_response || !state.draft_profile) return 3;
  if (/profile|review/i.test(state.current_step)) return 4;
  if (!state.delivery) return 5;
  return 6;
}

async function detail(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  return typeof body?.detail === "string" ? body.detail : fallback;
}

export function OnboardingFlow() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [step, setStep] = useState(0);
  const [answer, setAnswer] = useState("");
  const [openResponse, setOpenResponse] = useState("");
  const [profileDraft, setProfileDraft] = useState("");
  const [editingProfile, setEditingProfile] = useState(false);
  const [delivery, setDelivery] = useState<Delivery>(() => ({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    cadence_days: [2, 5], delivery_hour: 9, recommendation_count: 1,
  }));
  const [telegramUrl, setTelegramUrl] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  const questions = state?.questions?.length === 3 ? state.questions : fallbackQuestions;
  const currentQuestion = step < 3 ? questions[step] : null;
  const totalSteps = 7;

  useEffect(() => {
    let active = true;
    void fetch("/api/personal/onboarding", { cache: "no-store" }).then(async (response) => {
      if (response.status === 401) { window.location.replace("/login"); return; }
      if (!response.ok) throw new Error(await detail(response, "Onboarding could not load. Try again."));
      const next = await response.json() as OnboardingState;
      if (!active) return;
      if (next.status === "completed") { window.location.replace("/app"); return; }
      setState(next);
      setOpenResponse(next.open_response ?? "");
      setProfileDraft(next.draft_profile ?? "");
      if (next.delivery) setDelivery(next.delivery);
      setStep(stepFor(next));
    }).catch((cause) => active && setError(cause instanceof Error ? cause.message : "Onboarding could not load. Try again."));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const progress = useMemo(() => `${Math.min(step + 1, totalSteps)} of ${totalSteps}`, [step]);

  async function request(path: string, method: "POST" | "PUT", body?: unknown) {
    setBusy(path); setError("");
    try {
      const response = await fetch(`/api/personal/onboarding${path}`, {
        method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 401) { window.location.replace("/login"); return null; }
      if (!response.ok) throw new Error(await detail(response, "That step could not be saved. Try again."));
      const next = await response.json() as OnboardingState;
      setState(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That step could not be saved. Try again.");
      return null;
    } finally { setBusy(""); }
  }

  async function submitChoice(event: FormEvent) {
    event.preventDefault();
    if (!currentQuestion || !answer) return;
    const next = await request("/answers", "PUT", { question: currentQuestion.id, answer });
    if (next) { setAnswer(""); setStep(stepFor(next)); }
  }

  async function synthesize(event: FormEvent) {
    event.preventDefault();
    if (openResponse.trim().length < 20) { setError("Add a few sentences so the profile can reflect what matters to you."); return; }
    const saved = await request("/open-response", "PUT", { response: openResponse.trim() });
    if (!saved) return;
    const next = await request("/synthesize", "POST");
    if (next?.draft_profile) { setProfileDraft(next.draft_profile); setStep(4); }
  }

  async function acceptProfile(action: "accept" | "change") {
    const next = await request("/profile", "PUT", action === "change" ? { action, profile: profileDraft.trim() } : { action });
    if (next) { setEditingProfile(false); setStep(stepFor(next)); }
  }

  async function saveDelivery(event: FormEvent) {
    event.preventDefault();
    if (!delivery.cadence_days.length) { setError("Choose at least one delivery day."); return; }
    const next = await request("/delivery", "PUT", delivery);
    if (next) setStep(stepFor(next));
  }

  async function prepareTelegram() {
    setBusy("telegram-link"); setError("");
    try {
      const response = await fetch("/api/personal/account/telegram-link", { method: "POST", headers: { "Content-Type": "application/json" } });
      if (!response.ok) throw new Error(await detail(response, "A Telegram link could not be created. Try again."));
      const data = await response.json() as { url: string };
      setTelegramUrl(data.url);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "A Telegram link could not be created. Try again."); }
    finally { setBusy(""); }
  }

  async function finish(telegram: "connected" | "skipped") {
    const next = await request("/complete", "POST", { telegram });
    if (next?.status === "completed") window.location.replace("/app");
  }

  if (!state) return <main className="onboarding-loading"><span className="onboarding-mark" aria-hidden="true">F/</span><p role={error ? "alert" : "status"}>{error || "Preparing your feed…"}</p>{error && <button onClick={() => window.location.reload()}>Try again</button>}</main>;

  return <main className="onboarding-page">
    <header className="onboarding-header">
      <Link className="signal-wordmark" href="/"><span aria-hidden="true">F/</span>Finite Feed</Link>
      <p aria-label={`Onboarding step ${progress}`}>{progress}</p>
      <div className="onboarding-progress" aria-hidden="true"><span style={{ transform: `scaleX(${(step + 1) / totalSteps})` }} /></div>
    </header>
    <section className="onboarding-stage" key={step}>
      {currentQuestion && <form className="onboarding-question" onSubmit={submitChoice}>
        <h1 ref={headingRef} tabIndex={-1}>{currentQuestion.prompt}</h1>
        <p>Choose the closest fit. You can make it more specific in a moment.</p>
        <fieldset><legend className="sr-only">{currentQuestion.prompt}</legend><div className="onboarding-options">{currentQuestion.options.map((option) => <label key={option.value}><input type="radio" name={`question-${currentQuestion.id}`} value={option.value} checked={answer === option.value} onChange={() => setAnswer(option.value)} /><span>{option.label}</span></label>)}</div></fieldset>
        <button className="onboarding-next" disabled={!answer || !!busy}>{busy ? "Saving…" : "Continue"}</button>
      </form>}

      {step === 3 && <form className="onboarding-question onboarding-open" onSubmit={synthesize}>
        <h1 ref={headingRef} tabIndex={-1}>What should your feed understand about you?</h1>
        <p>A few sentences are enough. Share what you want to explore, what makes something worth watching, and anything you would rather skip.</p>
        <label htmlFor="open-interests">In your own words</label>
        <textarea id="open-interests" value={openResponse} onChange={(event) => setOpenResponse(event.target.value)} maxLength={3000} placeholder="I keep coming back to… I value videos that… Please avoid…" autoFocus required />
        <button className="onboarding-next" disabled={!!busy}>{busy ? "Building your profile…" : "Build my profile"}</button>
      </form>}

      {step === 4 && <div className="onboarding-question onboarding-review">
        <h1 ref={headingRef} tabIndex={-1}>Here’s what we heard.</h1>
        <p>This is the preference profile Finite Feed will use to choose recommendations.</p>
        {editingProfile ? <textarea aria-label="Edit preference profile" value={profileDraft} onChange={(event) => setProfileDraft(event.target.value)} maxLength={3000} autoFocus /> : <blockquote>{profileDraft || state.draft_profile}</blockquote>}
        <div className="onboarding-actions"><button className="onboarding-next" disabled={!!busy} onClick={() => void acceptProfile(editingProfile ? "change" : "accept")}>{busy ? "Saving…" : editingProfile ? "Save my changes" : "Okay"}</button><button className="onboarding-secondary" disabled={!!busy} onClick={() => { if (editingProfile) setProfileDraft(state.draft_profile ?? ""); setEditingProfile(!editingProfile); }}>{editingProfile ? "Cancel" : "I’d like to make a change"}</button></div>
      </div>}

      {step === 5 && <form className="onboarding-question onboarding-delivery" onSubmit={saveDelivery}>
        <h1 ref={headingRef} tabIndex={-1}>Set a pace that feels useful.</h1>
        <p>Choose when your recommendations should arrive. You can change this any time.</p>
        <div className="delivery-fields"><label>Time <select aria-label="Delivery time" value={delivery.delivery_hour} onChange={(event) => setDelivery({ ...delivery, delivery_hour: Number(event.target.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{new Date(2026, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}</option>)}</select></label><label>Timezone <input aria-label="Timezone" value={delivery.timezone} onChange={(event) => setDelivery({ ...delivery, timezone: event.target.value })} required /></label></div>
        <fieldset><legend>Delivery days</legend><div className="onboarding-days">{dayLabels.map((day, index) => <button type="button" key={day} aria-pressed={delivery.cadence_days.includes(index)} onClick={() => setDelivery({ ...delivery, cadence_days: delivery.cadence_days.includes(index) ? delivery.cadence_days.filter((value) => value !== index) : [...delivery.cadence_days, index].sort() })}>{day}</button>)}</div></fieldset>
        <fieldset><legend>Recommendations each delivery</legend><div className="onboarding-volume">{[1, 2, 3, 5].map((count) => <label key={count}><input type="radio" name="volume" value={count} checked={delivery.recommendation_count === count} onChange={() => setDelivery({ ...delivery, recommendation_count: count })} /><span>{count}</span></label>)}</div></fieldset>
        <button className="onboarding-next" disabled={!!busy}>{busy ? "Saving…" : "Continue"}</button>
      </form>}

      {step === 6 && <div className="onboarding-question onboarding-telegram">
        <h1 ref={headingRef} tabIndex={-1}>Where should we send your picks?</h1>
        <p>Connect Telegram for scheduled delivery, or start with recommendations on your dashboard.</p>
        <div className="telegram-choice"><div><h2>Telegram</h2><p>{state.telegram_connected ? "Your Telegram account is already connected and ready for scheduled recommendations." : "Receive each recommendation where you already chat."}</p>{state.telegram_connected ? <button className="onboarding-next" disabled={!!busy} onClick={() => void finish("connected")}>{busy ? "Finishing…" : "Continue to dashboard"}</button> : telegramUrl ? <><a className="onboarding-next" href={telegramUrl} target="_blank" rel="noreferrer">Open Telegram again</a><button className="onboarding-confirm" disabled={!!busy} onClick={() => void finish("connected")}>I’ve connected Telegram</button></> : <button className="onboarding-next" disabled={!!busy} onClick={() => void prepareTelegram()}>{busy ? "Preparing…" : "Connect Telegram"}</button>}</div><div className="coming-soon"><span>Coming soon</span><h2>Email & SMS</h2><p>More ways to receive your recommendations are on the way.</p></div></div>
        <button className="onboarding-secondary onboarding-skip" disabled={!!busy} onClick={() => void finish("skipped")}>Use dashboard only</button>
      </div>}
      {error && <p className="onboarding-error" role="alert">{error}</p>}
    </section>
  </main>;
}
