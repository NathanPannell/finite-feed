"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import styles from "@/components/onboarding-layout.module.css";

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
type TelegramLink = { url: string; code: string; expires_at: string };
type FieldErrors = { openResponse?: string; profile?: string; timezone?: string; days?: string };

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
const stageLabels = ["Focus", "Value", "Style", "Your words", "Profile", "Delivery", "Telegram"];
const commonTimezones = [
  "UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
  "America/Toronto", "America/Vancouver", "Europe/London", "Europe/Paris", "Europe/Berlin",
  "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney",
];

function stepFor(state: OnboardingState): number {
  const unanswered = [1, 2, 3].find((id) => !state.answers?.[String(id)]);
  if (unanswered) return unanswered - 1;
  if (!state.open_response || !state.draft_profile) return 3;
  if (/profile|review/i.test(state.current_step)) return 4;
  if (!state.delivery) return 5;
  return 6;
}

function isAcceptedProfile(state: OnboardingState) {
  return Boolean(state.delivery) || /delivery|telegram/i.test(state.current_step);
}

function canonicalTimezone(value: string) {
  if (/^[+-]\d{2}(?::?\d{2})?$/.test(value)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function sentenceCount(value: string) {
  return value.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.length ?? 0;
}

async function detail(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  return typeof body?.detail === "string" ? body.detail : fallback;
}

export function OnboardingFlow() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [step, setStep] = useState(0);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [openResponse, setOpenResponse] = useState("");
  const [profileDraft, setProfileDraft] = useState("");
  const [editingProfile, setEditingProfile] = useState(false);
  const [delivery, setDelivery] = useState<Delivery>(() => ({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    cadence_days: [2, 5], delivery_hour: 9, recommendation_count: 1,
  }));
  const [telegramLink, setTelegramLink] = useState<TelegramLink | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openResponseRef = useRef<HTMLTextAreaElement>(null);
  const profileRef = useRef<HTMLTextAreaElement>(null);
  const timezoneRef = useRef<HTMLInputElement>(null);
  const daysRef = useRef<HTMLFieldSetElement>(null);
  const stepsRef = useRef<HTMLElement>(null);
  const navigationEpochRef = useRef(0);

  const questions = state?.questions?.length === 3 ? state.questions : fallbackQuestions;
  const currentQuestion = step < 3 ? questions[step] : null;
  const totalSteps = stageLabels.length;
  const progress = `${step + 1} of ${totalSteps}`;
  const profileAccepted = state ? isAcceptedProfile(state) : false;
  const savedThrough = state ? stepFor(state) - 1 : -1;
  const telegramExpiry = telegramLink ? Date.parse(telegramLink.expires_at) : 0;
  const telegramExpired = Boolean(telegramLink) && (!Number.isFinite(telegramExpiry) || telegramExpiry <= now);
  const telegramExpiryLabel = telegramLink && Number.isFinite(telegramExpiry)
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(telegramExpiry)
    : "the stated time";
  const timezoneOptions = useMemo(() => {
    try {
      return Array.from(new Set([...commonTimezones, ...Intl.supportedValuesOf("timeZone")])).sort();
    } catch {
      return commonTimezones;
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/personal/onboarding", { cache: "no-store" }).then(async (response) => {
      if (response.status === 401) { window.location.replace("/login"); return; }
      if (!response.ok) throw new Error(await detail(response, "Onboarding could not load. Try again."));
      const next = await response.json() as OnboardingState;
      if (!active) return;
      if (next.status === "completed") { window.location.replace("/app"); return; }
      setState(next);
      setAnswerDrafts(next.answers ?? {});
      setOpenResponse(next.open_response ?? "");
      setProfileDraft(next.draft_profile ?? "");
      if (next.delivery) setDelivery(next.delivery);
      setStep(stepFor(next));
    }).catch((cause) => active && setError(cause instanceof Error ? cause.message : "Onboarding could not load. Try again."));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    headingRef.current?.focus();
    stepsRef.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [step]);

  useEffect(() => {
    if (!telegramLink) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [telegramLink]);

  async function request(path: string, method: "POST" | "PUT", body?: unknown) {
    setBusy(path);
    setError("");
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
    } finally {
      setBusy("");
    }
  }

  function goToStep(nextStep: number) {
    navigationEpochRef.current += 1;
    setError("");
    setFieldErrors({});
    setEditingProfile(false);
    setStep(nextStep);
  }

  async function submitChoice(event: FormEvent) {
    event.preventDefault();
    if (!state || !currentQuestion) return;
    const selected = answerDrafts[String(currentQuestion.id)];
    if (!selected) return;
    if (state.answers?.[String(currentQuestion.id)] === selected) {
      goToStep(step + 1);
      return;
    }
    const navigationEpoch = navigationEpochRef.current;
    const next = await request("/answers", "PUT", { question: currentQuestion.id, answer: selected });
    if (next && navigationEpoch === navigationEpochRef.current) goToStep(step + 1);
  }

  async function synthesize(event: FormEvent) {
    event.preventDefault();
    if (!state) return;
    const normalized = openResponse.trim();
    if (normalized.length < 20) {
      setFieldErrors({ openResponse: normalized ? "Add a little more detail so your profile reflects what matters to you." : "Enter a few sentences about what you want to watch." });
      openResponseRef.current?.focus();
      return;
    }
    setFieldErrors({});
    if (normalized === state.open_response && state.draft_profile) {
      setProfileDraft(state.draft_profile);
      goToStep(4);
      return;
    }
    const navigationEpoch = navigationEpochRef.current;
    if (normalized !== state.open_response) {
      const saved = await request("/open-response", "PUT", { response: normalized });
      if (!saved || navigationEpoch !== navigationEpochRef.current) return;
      setOpenResponse(normalized);
    }
    const next = await request("/synthesize", "POST");
    if (next?.draft_profile && navigationEpoch === navigationEpochRef.current) {
      setProfileDraft(next.draft_profile);
      goToStep(4);
    }
  }

  async function acceptProfile(action: "accept" | "change") {
    if (!state) return;
    const normalized = profileDraft.trim();
    if (action === "change" && (sentenceCount(normalized) < 2 || sentenceCount(normalized) > 5)) {
      setFieldErrors({ profile: "Write a profile of 2 to 5 sentences." });
      profileRef.current?.focus();
      return;
    }
    setFieldErrors({});
    if (profileAccepted && normalized === state.draft_profile) {
      goToStep(5);
      return;
    }
    const navigationEpoch = navigationEpochRef.current;
    const next = await request("/profile", "PUT", action === "change" ? { action, profile: normalized } : { action });
    if (next && navigationEpoch === navigationEpochRef.current) {
      setEditingProfile(false);
      goToStep(stepFor(next));
    }
  }

  async function saveDelivery(event: FormEvent) {
    event.preventDefault();
    if (!state) return;
    const normalizedTimezone = delivery.timezone.trim();
    const canonical = normalizedTimezone ? canonicalTimezone(normalizedTimezone) : null;
    if (!canonical) {
      setFieldErrors({ timezone: "Enter a valid IANA timezone, such as America/Los_Angeles." });
      timezoneRef.current?.focus();
      return;
    }
    if (!delivery.cadence_days.length) {
      setFieldErrors({ days: "Choose at least one delivery day." });
      daysRef.current?.focus();
      return;
    }
    const payload = { ...delivery, timezone: canonical };
    setDelivery(payload);
    setFieldErrors({});
    if (state.delivery && JSON.stringify(state.delivery) === JSON.stringify(payload)) {
      goToStep(6);
      return;
    }
    const navigationEpoch = navigationEpochRef.current;
    const next = await request("/delivery", "PUT", payload);
    if (next && navigationEpoch === navigationEpochRef.current) goToStep(stepFor(next));
  }

  async function prepareTelegram() {
    setBusy("telegram-link");
    setError("");
    try {
      const response = await fetch("/api/personal/account/telegram-link", { method: "POST", headers: { "Content-Type": "application/json" } });
      if (response.status === 401) { window.location.replace("/login"); return; }
      if (!response.ok) throw new Error(await detail(response, "Telegram connection options could not be created. Try again."));
      setTelegramLink(await response.json() as TelegramLink);
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Telegram connection options could not be created. Try again.");
    } finally {
      setBusy("");
    }
  }

  async function finish(telegram: "connected" | "skipped") {
    const navigationEpoch = navigationEpochRef.current;
    const next = await request("/complete", "POST", { telegram });
    if (next?.status === "completed" && navigationEpoch === navigationEpochRef.current) window.location.replace("/app");
  }

  function answerLabel(question: Question) {
    const value = answerDrafts[String(question.id)];
    return question.options.find((option) => option.value === value)?.label ?? "Not answered";
  }

  if (!state) return <main className="onboarding-loading"><span className="onboarding-mark" aria-hidden="true">F/</span><p role={error ? "alert" : "status"}>{error || "Preparing your feed…"}</p>{error && <button onClick={() => window.location.reload()}>Try again</button>}</main>;

  return <main className="onboarding-page">
    <header className="onboarding-header">
      <Link className="signal-wordmark" href="/"><span aria-hidden="true">F/</span>Finite Feed</Link>
      <p aria-label={`Onboarding step ${progress}: ${stageLabels[step]}`}>Step {progress} · {stageLabels[step]}</p>
      <div className="onboarding-progress" aria-hidden="true"><span style={{ transform: `scaleX(${(step + 1) / totalSteps})` }} /></div>
    </header>
    <nav ref={stepsRef} className={styles.steps} aria-label="Onboarding stages">
      {stageLabels.map((label, index) => <span key={label} aria-label={`${label}${index <= savedThrough ? ", saved" : ""}`} aria-current={step === index ? "step" : undefined} data-saved={index <= savedThrough}>{label}</span>)}
    </nav>
    <section className="onboarding-stage" key={step}>
      <div className={styles.stageInner}>
        {step > 0 && <button className={styles.back} type="button" disabled={!!busy} onClick={() => goToStep(step - 1)}>Back</button>}

        {step >= 3 && <details className={styles.reviewSummary} open={step === 3 || step === 4}>
          <summary>Review your answers</summary>
          <dl>
            {questions.map((question, index) => <div key={question.id}><dt>{stageLabels[index]}</dt><dd>{answerLabel(question)}</dd><button type="button" disabled={!!busy} onClick={() => goToStep(index)}>Edit</button></div>)}
            <div><dt>Your words</dt><dd>{openResponse.trim() || "Not answered"}</dd>{step > 3 && <button type="button" disabled={!!busy} onClick={() => goToStep(3)}>Edit</button>}</div>
          </dl>
        </details>}

        {currentQuestion && <form className="onboarding-question" onSubmit={submitChoice}>
          <h1 ref={headingRef} tabIndex={-1}>{currentQuestion.prompt}</h1>
          <p>Choose the closest fit. You can make it more specific in a moment.</p>
          <fieldset disabled={!!busy}><legend className="sr-only">{currentQuestion.prompt}</legend><div className="onboarding-options">{currentQuestion.options.map((option) => <label key={option.value}><input type="radio" name={`question-${currentQuestion.id}`} value={option.value} checked={answerDrafts[String(currentQuestion.id)] === option.value} onChange={() => setAnswerDrafts({ ...answerDrafts, [String(currentQuestion.id)]: option.value })} /><span>{option.label}</span></label>)}</div></fieldset>
          <button className="onboarding-next" disabled={!answerDrafts[String(currentQuestion.id)] || !!busy}>{busy ? "Saving…" : "Continue"}</button>
        </form>}

        {step === 3 && <form className="onboarding-question onboarding-open" onSubmit={synthesize}>
          <h1 ref={headingRef} tabIndex={-1}>What should your feed understand about you?</h1>
          <p>A few sentences are enough. Share what you want to explore, what makes something worth watching, and anything you would rather skip.</p>
          <label htmlFor="open-interests">In your own words</label>
          <textarea ref={openResponseRef} id="open-interests" value={openResponse} onChange={(event) => { setOpenResponse(event.target.value); setFieldErrors({}); }} maxLength={3000} placeholder="I keep coming back to… I value videos that… Please avoid…" aria-invalid={fieldErrors.openResponse ? "true" : undefined} aria-describedby={fieldErrors.openResponse ? "open-response-error" : undefined} disabled={!!busy} autoFocus required />
          {fieldErrors.openResponse && <p id="open-response-error" className={styles.fieldError}>{fieldErrors.openResponse}</p>}
          <button className="onboarding-next" disabled={!!busy}>{busy ? "Building your profile…" : "Build my profile"}</button>
        </form>}

        {step === 4 && <div className="onboarding-question onboarding-review">
          <h1 ref={headingRef} tabIndex={-1}>Here’s what we heard.</h1>
          <p>This is the preference profile Finite Feed will use to choose recommendations.</p>
          {editingProfile ? <><textarea ref={profileRef} aria-label="Edit preference profile" value={profileDraft} onChange={(event) => { setProfileDraft(event.target.value); setFieldErrors({}); }} aria-invalid={fieldErrors.profile ? "true" : undefined} aria-describedby={fieldErrors.profile ? "profile-error" : undefined} disabled={!!busy} maxLength={3000} autoFocus />{fieldErrors.profile && <p id="profile-error" className={styles.fieldError}>{fieldErrors.profile}</p>}</> : <blockquote>{state.draft_profile}</blockquote>}
          {profileAccepted && <p className={styles.acceptedNote}>This profile is already saved. To rebuild it, edit one of your answers above.</p>}
          <div className="onboarding-actions">
            <button className="onboarding-next" disabled={!!busy} onClick={() => void acceptProfile(editingProfile ? "change" : "accept")}>{busy ? "Saving…" : editingProfile ? "Save my changes" : "Use this profile"}</button>
            {!profileAccepted && <button className="onboarding-secondary" type="button" disabled={!!busy} onClick={() => { if (editingProfile) setProfileDraft(state.draft_profile ?? ""); setFieldErrors({}); setEditingProfile(!editingProfile); }}>{editingProfile ? "Cancel" : "Edit profile"}</button>}
          </div>
        </div>}

        {step === 5 && <form className="onboarding-question onboarding-delivery" onSubmit={saveDelivery}>
          <h1 ref={headingRef} tabIndex={-1}>Set a pace that feels useful.</h1>
          <p>Choose when your recommendations should arrive. You can change this any time.</p>
          <div className="delivery-fields">
            <label>Time <select aria-label="Delivery time" value={delivery.delivery_hour} onChange={(event) => setDelivery({ ...delivery, delivery_hour: Number(event.target.value) })} disabled={!!busy}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{new Date(2026, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}</option>)}</select></label>
            <label>Timezone <input ref={timezoneRef} aria-label="Timezone" list="onboarding-timezones" value={delivery.timezone} onChange={(event) => { setFieldErrors({}); setDelivery({ ...delivery, timezone: event.target.value }); }} aria-invalid={fieldErrors.timezone ? "true" : undefined} aria-describedby={fieldErrors.timezone ? "timezone-help timezone-error" : "timezone-help"} disabled={!!busy} required /><datalist id="onboarding-timezones">{timezoneOptions.map((timezone) => <option key={timezone} value={timezone} />)}</datalist><span id="timezone-help" className={styles.fieldHelp}>Use a city-based IANA timezone so daylight saving changes stay accurate.</span>{fieldErrors.timezone && <span id="timezone-error" className={styles.fieldError}>{fieldErrors.timezone}</span>}</label>
          </div>
          <fieldset ref={daysRef} tabIndex={-1} aria-describedby={fieldErrors.days ? "days-error" : undefined} disabled={!!busy}><legend>Delivery days</legend><div className="onboarding-days">{dayLabels.map((day, index) => <button type="button" key={day} aria-pressed={delivery.cadence_days.includes(index)} onClick={() => { setFieldErrors({}); setDelivery({ ...delivery, cadence_days: delivery.cadence_days.includes(index) ? delivery.cadence_days.filter((value) => value !== index) : [...delivery.cadence_days, index].sort() }); }}>{day}</button>)}</div>{fieldErrors.days && <span id="days-error" className={styles.fieldError}>{fieldErrors.days}</span>}</fieldset>
          <fieldset disabled={!!busy}><legend>Recommendations each delivery</legend><div className="onboarding-volume">{[1, 2, 3, 5].map((count) => <label key={count}><input type="radio" name="volume" value={count} checked={delivery.recommendation_count === count} onChange={() => setDelivery({ ...delivery, recommendation_count: count })} /><span>{count}</span></label>)}</div></fieldset>
          <button className="onboarding-next" disabled={!!busy}>{busy ? "Saving…" : "Continue"}</button>
        </form>}

        {step === 6 && <div className="onboarding-question onboarding-telegram">
          <h1 ref={headingRef} tabIndex={-1}>Where should we send your picks?</h1>
          <p>Connect Telegram for scheduled delivery, or start with recommendations on your dashboard.</p>
          <div className={styles.telegramPrimary}>
            <h2>Telegram</h2>
            <p>{state.telegram_connected ? "Your Telegram account is already connected and ready for scheduled recommendations." : "Receive each recommendation where you already chat."}</p>
            {state.telegram_connected ? <button className="onboarding-next" disabled={!!busy} onClick={() => void finish("connected")}>{busy ? "Finishing…" : "Continue to dashboard"}</button> : telegramLink ? <div className={styles.telegramInstructions}>
              <p>Open the Finite Feed bot in Telegram, start a private chat, then send this single-use code:</p>
              <strong className={styles.telegramCode} aria-label="Your six-digit Telegram connection code">{telegramLink.code}</strong>
              <p className={telegramExpired ? styles.expired : undefined}><time dateTime={telegramLink.expires_at}>{telegramExpired ? `This code expired at ${telegramExpiryLabel}.` : `This code expires at ${telegramExpiryLabel}.`}</time>{telegramExpired ? " Get a new code to continue." : " It can be used once."}</p>
              {!telegramExpired && <><a className="onboarding-next" href={telegramLink.url} target="_blank" rel="noreferrer" aria-disabled={!!busy} onClick={(event) => { if (busy) event.preventDefault(); }}>Open Telegram</a><button className="onboarding-confirm" type="button" disabled={!!busy} onClick={() => void finish("connected")}>I’ve connected Telegram</button></>}
              <button className={styles.regenerate} type="button" disabled={!!busy} onClick={() => void prepareTelegram()}>{busy ? "Creating a new code…" : "Get a new code"}</button>
            </div> : <button className="onboarding-next" disabled={!!busy} onClick={() => void prepareTelegram()}>{busy ? "Creating options…" : "Get Telegram connection options"}</button>}
          </div>
          <p className={styles.unavailable}><strong>Email and SMS</strong> delivery isn’t available yet.</p>
          <button className="onboarding-secondary onboarding-skip" disabled={!!busy} onClick={() => void finish("skipped")}>Use dashboard only</button>
        </div>}

        {error && <p className="onboarding-error" role="alert">{error}</p>}
      </div>
    </section>
  </main>;
}
