"use client";

/* eslint-disable @next/next/no-img-element -- YouTube supplies dynamic external image hosts. */

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Account, AccountControls } from "@/components/account-controls";
import { SignalShell } from "@/components/signal-shell";
import settingsStyles from "@/components/settings-layout.module.css";

type Profile = {
  preference_statement: string;
  timezone: string;
  cadence_days: number[];
  delivery_hour: number;
  recommendation_count: number;
  version: number;
  updated_at: string;
};

type Channel = { id: string; name: string; url: string; thumbnail_url: string | null; is_default: boolean };
type ResolvedChannel = {
  youtube_channel_id: string;
  name: string;
  url: string;
  thumbnail_url: string | null;
  already_tracked: boolean;
  can_reactivate: boolean;
};
type Recommendation = {
  id: string;
  title: string;
  channel_name: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  rationale: string;
  rating: "up" | "down" | null;
};
type Notice = { message: string; tone: "error" | "success" } | null;
type FormNotice = Notice;
type DeliveryNotice = (Exclude<Notice, null> & { reason?: "timezone" }) | null;
type SourceState = "idle" | "loading" | "resolved" | "invalid" | "error" | "duplicate";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const minimumPicks = 1;
const maximumPicks = 10;

function durationLabel(seconds: number | null) {
  if (!seconds) return "Duration pending";
  return `${Math.round(seconds / 60)} min`;
}

function conciseRationale(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  const firstSentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
  if (firstSentence.length <= 160) return firstSentence;
  return `${firstSentence.slice(0, 157).trimEnd()}…`;
}

function validYouTubeUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function canonicalTimezone(value: string): string | null {
  try {
    const zone = new Intl.DateTimeFormat(undefined, { timeZone: value.trim() }).resolvedOptions().timeZone;
    return /^[+-]/.test(zone) ? null : zone;
  } catch {
    return null;
  }
}

async function responseMessage(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  if (body && typeof body === "object" && typeof body.detail === "string") return body.detail;
  return fallback;
}

export function FiniteFeedDashboard({ apiBaseUrl, settings = false }: { apiBaseUrl: string; settings?: boolean }) {
  const [routeReady, setRouteReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [memoryEditing, setMemoryEditing] = useState(false);
  const [channelUrl, setChannelUrl] = useState("");
  const [resolvedChannel, setResolvedChannel] = useState<ResolvedChannel | null>(null);
  const [sourceState, setSourceState] = useState<SourceState>("idle");
  const [sourceMessage, setSourceMessage] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [deliveryBaseline, setDeliveryBaseline] = useState<Pick<Profile, "timezone" | "cadence_days" | "delivery_hour" | "recommendation_count"> | null>(null);
  const [deliveryNotice, setDeliveryNotice] = useState<DeliveryNotice>(null);
  const [memoryNotice, setMemoryNotice] = useState<FormNotice>(null);
  const [accountDelivery, setAccountDelivery] = useState<Account | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Channel | null>(null);
  const removalTrigger = useRef<HTMLButtonElement | null>(null);
  const sourceInput = useRef<HTMLInputElement | null>(null);
  const [timezoneError, setTimezoneError] = useState(false);
  const deliveryDirty = Boolean(profile && deliveryBaseline && (
    profile.timezone !== deliveryBaseline.timezone ||
    profile.delivery_hour !== deliveryBaseline.delivery_hour ||
    profile.recommendation_count !== deliveryBaseline.recommendation_count ||
    profile.cadence_days.join(",") !== deliveryBaseline.cadence_days.join(",")
  ));

  const load = useCallback(async () => {
    if (!apiBaseUrl) return;
    setLoading(true);
    try {
      const accountResponse = await fetch(`${apiBaseUrl}/account`, { cache: "no-store" });
      if (accountResponse.status === 401) { window.location.replace("/login"); return; }
      if (!accountResponse.ok) throw new Error("Your account could not be checked. Try again in a moment.");
      const account = await accountResponse.json() as { onboarding_completed?: boolean };
      if (account.onboarding_completed === false) { window.location.replace("/onboarding"); return; }
      setRouteReady(true);
      const responses = await Promise.all([
        fetch(`${apiBaseUrl}/profile`, { cache: "no-store" }),
        fetch(`${apiBaseUrl}/channels`, { cache: "no-store" }),
        ...(!settings ? [fetch(`${apiBaseUrl}/recommendations`, { cache: "no-store" })] : []),
      ]);
      if (responses.some((response) => response.status === 401)) { window.location.replace("/login"); return; }
      if (responses.some((response) => !response.ok)) throw new Error("The feed could not reach its source. Try again in a moment.");
      const [nextProfile, nextChannels, nextRecommendations = []] = await Promise.all(responses.map((response) => response.json()));
      setProfile(nextProfile);
      setDeliveryBaseline({ timezone: nextProfile.timezone, cadence_days: nextProfile.cadence_days, delivery_hour: nextProfile.delivery_hour, recommendation_count: nextProfile.recommendation_count });
      setMemoryDraft(nextProfile.preference_statement);
      setChannels(nextChannels);
      setRecommendations(nextRecommendations);
      setNotice(null);
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : "Could not load Finite Feed. Try again.", tone: "error" });
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, settings]);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  useEffect(() => {
    if (!channelUrl.trim()) return;
    const controller = new AbortController();
    const task = window.setTimeout(async () => {
      if (!validYouTubeUrl(channelUrl.trim())) {
        setSourceState("invalid");
        setSourceMessage("Use a YouTube channel, handle, video, or youtu.be URL.");
        return;
      }
      setSourceState("loading");
      setSourceMessage("Finding the channel behind this URL…");
      try {
        const response = await fetch(`${apiBaseUrl}/channels/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: channelUrl.trim() }),
          signal: controller.signal,
        });
        if (!response.ok) {
          setSourceState(response.status === 422 ? "invalid" : "error");
          setSourceMessage(await responseMessage(response, "Channel lookup failed. Check the URL and try again."));
          return;
        }
        if (controller.signal.aborted) return;
        const channel = (await response.json()) as ResolvedChannel;
        setResolvedChannel(channel);
        if (channel.already_tracked) {
          setSourceState("duplicate");
          setSourceMessage(`${channel.name} is already tracked.`);
        } else {
          setSourceState("resolved");
          setSourceMessage(channel.can_reactivate ? `${channel.name} is ready to track again.` : `${channel.name} is ready to add.`);
        }
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setSourceState("error");
        setSourceMessage("Channel lookup failed. Check your connection and try again.");
      }
    }, 450);
    return () => {
      window.clearTimeout(task);
      controller.abort();
    };
  }, [apiBaseUrl, channelUrl]);

  async function saveDelivery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || busyAction) return;
    const timezone = canonicalTimezone(profile.timezone);
    if (!timezone) {
      setTimezoneError(true);
      setDeliveryNotice({ message: "Enter an IANA timezone such as America/Los_Angeles, then save again.", tone: "error", reason: "timezone" });
      return;
    }
    setBusyAction("delivery");
    setDeliveryNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/profile/delivery`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cadence_days: profile.cadence_days,
          recommendation_count: profile.recommendation_count,
          timezone,
          delivery_hour: profile.delivery_hour,
        }),
      });
      if (!response.ok) {
        setDeliveryNotice({ message: "Could not save your delivery preferences. Try again.", tone: "error" });
        return;
      }
      const saved = (await response.json()) as Profile;
      setProfile((current) => current ? { ...saved, preference_statement: current.preference_statement } : saved);
      setDeliveryBaseline({ timezone: saved.timezone, cadence_days: saved.cadence_days, delivery_hour: saved.delivery_hour, recommendation_count: saved.recommendation_count });
      setDeliveryNotice({ message: "Delivery preferences saved.", tone: "success" });
    } catch {
      setDeliveryNotice({ message: "Could not save your delivery preferences. Check your connection and try again.", tone: "error" });
    } finally {
      setBusyAction(null);
    }
  }

  async function saveMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || busyAction) return;
    setBusyAction("memory");
    setMemoryNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/profile/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preference_statement: memoryDraft, expected_version: profile.version }),
      });
      if (!response.ok) {
        setMemoryNotice({ message: response.status === 409 ? "Your interests changed elsewhere. Reload and try again." : "Could not save your interests. Check the field and try again.", tone: "error" });
        return;
      }
      const saved = (await response.json()) as Profile;
      setProfile((current) => current ? {
        ...saved,
        timezone: current.timezone,
        cadence_days: current.cadence_days,
        delivery_hour: current.delivery_hour,
        recommendation_count: current.recommendation_count,
      } : saved);
      setMemoryDraft(saved.preference_statement);
      setMemoryEditing(false);
      setMemoryNotice({ message: "Your interests were saved.", tone: "success" });
    } catch {
      setMemoryNotice({ message: "Could not save your interests. Check your connection and try again.", tone: "error" });
    } finally {
      setBusyAction(null);
    }
  }

  function changeChannelUrl(value: string) {
    setChannelUrl(value);
    setResolvedChannel(null);
    setSourceState("idle");
    setSourceMessage("");
  }

  async function addChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyAction || !resolvedChannel || sourceState !== "resolved") return;
    setBusyAction("source");
    try {
      const response = await fetch(`${apiBaseUrl}/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: channelUrl.trim() }),
      });
      if (!response.ok) {
        const message = await responseMessage(response, "That source was not added. Check the URL and try again.");
        setSourceState(response.status === 409 ? "duplicate" : "error");
        setSourceMessage(message);
        return;
      }
      const added = (await response.json()) as Channel;
      setChannels((current) => [...current.filter((channel) => channel.id !== added.id), added]);
      setChannelUrl("");
      setResolvedChannel(null);
      setSourceState("idle");
      setNotice({ message: `${added.name} is now tracked.`, tone: "success" });
    } catch {
      setSourceState("error");
      setSourceMessage("That source was not added. Check your connection and try again.");
    } finally {
      setBusyAction(null);
    }
  }

  async function removeChannel(channel: Channel) {
    if (busyAction) return;
    setBusyAction(`remove-${channel.id}`);
    try {
      const response = await fetch(`${apiBaseUrl}/channels/${channel.id}`, { method: "DELETE" });
      if (!response.ok) {
        setNotice({ message: `${channel.name} was not removed. Try again.`, tone: "error" });
        return;
      }
      setChannels((current) => current.filter((item) => item.id !== channel.id));
      setPendingRemoval(null);
      setNotice({ message: `${channel.name} is no longer tracked. Add its YouTube URL below to track it again.`, tone: "success" });
      sourceInput.current?.focus();
    } catch {
      setNotice({ message: `${channel.name} was not removed. Check your connection and try again.`, tone: "error" });
    } finally {
      setBusyAction(null);
    }
  }

  async function rate(id: string, rating: "up" | "down") {
    setBusyAction(`rate-${id}`);
    try {
      const response = await fetch(`${apiBaseUrl}/recommendations/${id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      });
      if (!response.ok) {
        setNotice({ message: "Feedback was not recorded. Try again.", tone: "error" });
        return;
      }
      const updated = (await response.json()) as Recommendation;
      setRecommendations((current) => current.map((item) => (item.id === id ? updated : item)));
      setNotice({ message: rating === "up" ? "Saved — more like this." : "Saved — less like this.", tone: "success" });
    } catch {
      setNotice({ message: "Feedback was not recorded. Check your connection and try again.", tone: "error" });
    } finally {
      setBusyAction(null);
    }
  }

  async function generate() {
    setBusyAction("generate");
    try {
      const response = await fetch(`${apiBaseUrl}/recommendations/generate`, { method: "POST" });
      if (!response.ok) {
        setNotice({ message: await responseMessage(response, "A new recommendation could not be made. Try again."), tone: "error" });
        return;
      }
      await load();
      setNotice({ message: "A new recommendation is ready.", tone: "success" });
    } catch {
      setNotice({ message: "A new recommendation could not be made. Check your connection and try again.", tone: "error" });
    } finally {
      setBusyAction(null);
    }
  }

  if (!routeReady) return <main className="route-loading"><span className="onboarding-mark" aria-hidden="true">F/</span><p role={notice ? "alert" : "status"}>{notice?.message || "Opening your feed…"}</p>{notice && <button onClick={() => void load()}>Try again</button>}</main>;
  if (!loading && !profile) return <SignalShell active={settings ? "settings" : "feed"}><main className="public-main"><h1>We couldn’t load your feed.</h1><p role="alert">{notice?.message}</p><button className="save-action" onClick={() => void load()}>Try again</button><p><Link href="/">Return home</Link></p></main></SignalShell>;

  return (
    <SignalShell active={settings ? "settings" : "feed"}>
      <main id="top" className={`public-main ${settings ? "personal-settings" : "personal-feed"}`}>
        {!settings && <header className="feed-toolbar">
          <p>Selected from your sources and shaped by what you find useful.</p>
          <button className="signal-action" onClick={() => void generate()} disabled={busyAction === "generate" || loading}>
            {busyAction === "generate" ? "Choosing…" : "Choose one now"}
          </button>
        </header>}

        {notice && <p className={notice.tone === "error" ? "signal-error" : "signal-notice"} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p>}

        {settings && <nav className={settingsStyles.settingsNav} aria-label="Settings sections">
          <a href="#delivery">Delivery</a><a href="#interests">Interests</a><a href="#sources">Sources</a><a href="#account">Account</a>
        </nav>}
        {!settings && <p className="feed-settings-link"><Link href="/settings">Shape your interests, sources, and Telegram delivery</Link></p>}
        <div className={settings ? settingsStyles.settingsGrid : "reading-grid"}>
          {!settings && <section id="recommendations" className="feed-column" aria-labelledby="recommendations-heading">
            <header className="section-line">
              <h2 id="recommendations-heading">For you</h2>
              <span>{recommendations.length ? `${recommendations.length} recent` : "Queue open"}</span>
            </header>

            {loading ? (
              <div className="recommendation-loading" aria-label="Loading recommendations"><span /><span /><span /></div>
            ) : recommendations.length ? (
              <div className="recommendation-list">
                {recommendations.slice(0, 7).map((item) => (
                  <article key={item.id} className="recommendation-row">
                    <a className="recommendation-link" href={`${apiBaseUrl}/r/${item.id}`} target="_blank" rel="noreferrer" aria-label={`Watch ${item.title} on YouTube`}>
                      <span className="recommendation-thumbnail">
                        {item.thumbnail_url ? <img src={item.thumbnail_url} alt="" width="480" height="270" /> : <span aria-hidden="true">F/</span>}
                      </span>
                      <span className="recommendation-copy">
                        <span className="recommendation-meta"><span>{item.channel_name}</span><span>{durationLabel(item.duration_seconds)}</span></span>
                        <span className="recommendation-title" role="heading" aria-level={3}>{item.title}</span>
                        {item.rationale && <span className="recommendation-rationale">{conciseRationale(item.rationale)}</span>}
                      </span>
                    </a>
                    <div className="recommendation-feedback" role="group" aria-label={`Rate ${item.title}`}>
                      <button className="fit-action useful-action" aria-pressed={item.rating === "up"} disabled={busyAction === `rate-${item.id}`} onClick={() => void rate(item.id, "up")}>Useful</button>
                      <button className="fit-action not-useful-action" aria-pressed={item.rating === "down"} disabled={busyAction === `rate-${item.id}`} onClick={() => void rate(item.id, "down")}>Not useful</button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="signal-empty">
                <h3>A fresh start for your attention.</h3>
                <p><Link href="/settings">Tell us your interests and check your sources</Link>, then choose your first recommendation. New sources may need a refresh before videos are ready.</p>
              </div>
            )}
          </section>}

          <aside className={settings ? settingsStyles.settingsColumn : "memory-column"}>
            <section id={settings ? "delivery" : "preferences"} className={settings ? `${settingsStyles.taskSection} delivery-sheet` : "delivery-sheet"} aria-labelledby="delivery-heading">
              <header className="section-line"><h2 id="delivery-heading">Delivery preferences</h2></header>
              {accountDelivery && <p className={settingsStyles.formFeedback} role="status">Telegram is {accountDelivery.telegram_connected ? "connected" : "not connected"}.{accountDelivery.delivery_paused ? " Delivery is paused." : ""} Manage the connection below in Account & privacy.</p>}
              {profile ? (
                <form className="delivery-form" onSubmit={saveDelivery}>
                  <label htmlFor="delivery-timezone">Timezone</label><input disabled={!!busyAction} id="delivery-timezone" value={profile.timezone} onChange={(event) => { const timezone = event.target.value; if (canonicalTimezone(timezone)) { setTimezoneError(false); setDeliveryNotice((current) => current?.reason === "timezone" ? null : current); } setProfile({ ...profile, timezone }); }} placeholder="America/Los_Angeles" aria-invalid={timezoneError || undefined} aria-describedby={timezoneError ? "delivery-timezone-error" : undefined} required />{timezoneError && <p id="delivery-timezone-error" className={settingsStyles.formFeedback} data-tone="error" role="alert">Enter an IANA timezone such as America/Los_Angeles.</p>}<label htmlFor="delivery-hour">Delivery hour (local time)</label><select disabled={!!busyAction} id="delivery-hour" value={profile.delivery_hour} onChange={(event) => setProfile({ ...profile, delivery_hour: Number(event.target.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select>
                  <fieldset className="day-fieldset">
                    <legend>Delivery days</legend>
                    <div className="day-picker">{days.map((day, index) => {
                      const selected = profile.cadence_days.includes(index);
                      return <button type="button" disabled={!!busyAction} key={day} aria-pressed={selected} onClick={() => {
                        if (selected && profile.cadence_days.length === 1) {
                          setDeliveryNotice({ message: "Keep at least one delivery day selected.", tone: "error" });
                          return;
                        }
                        setProfile({ ...profile, cadence_days: selected ? profile.cadence_days.filter((value) => value !== index) : [...profile.cadence_days, index].sort() });
                      }}>{day.slice(0, 2)}</button>;
                    })}</div>
                  </fieldset>
                  <div className="picks-setting">
                    <span id="picks-label">Picks per delivery</span>
                    <div className="picks-stepper" role="group" aria-labelledby="picks-label">
                      <button type="button" aria-label="Decrease picks" disabled={!!busyAction || profile.recommendation_count <= minimumPicks} onClick={() => setProfile({ ...profile, recommendation_count: Math.max(minimumPicks, profile.recommendation_count - 1) })}>−</button>
                      <output aria-live="polite" aria-label={`${profile.recommendation_count} ${profile.recommendation_count === 1 ? "pick" : "picks"}`}>{profile.recommendation_count}</output>
                      <button type="button" aria-label="Increase picks" disabled={!!busyAction || profile.recommendation_count >= maximumPicks} onClick={() => setProfile({ ...profile, recommendation_count: Math.min(maximumPicks, profile.recommendation_count + 1) })}>+</button>
                    </div>
                  </div>
                  <button className="save-action" disabled={!!busyAction || !deliveryDirty}>{busyAction === "delivery" ? "Saving…" : deliveryDirty ? "Save delivery preferences" : "Delivery preferences saved"}</button>
                  {deliveryNotice && <p className={settingsStyles.formFeedback} data-tone={deliveryNotice.tone} role={deliveryNotice.tone === "error" ? "alert" : "status"}>{deliveryNotice.message}</p>}
                </form>
              ) : <div className="sheet-skeleton" aria-label="Loading delivery preferences" />}
            </section>

            <section id={settings ? "interests" : "memory"} className={settings ? `${settingsStyles.taskSection} preference-memory` : "preference-memory"} aria-labelledby="memory-heading">
              <header className="section-line"><h2 id="memory-heading">Preference memory</h2>{profile && <span>Version {profile.version}</span>}</header>
              {profile ? <>
                <p className="memory-summary">{profile.preference_statement}</p>
                {!memoryEditing ? (
                  <button className="memory-action" disabled={!!busyAction} onClick={() => { setMemoryNotice(null); setMemoryEditing(true); }}>Edit interests</button>
                ) : (
                  <form className="memory-editor" onSubmit={saveMemory}>
                    <label htmlFor="memory-draft">Your interests and exclusions</label><p>Describe what you want to learn and what to avoid. For example: practical psychology and new research; skip motivational speeches.</p>
                    <textarea disabled={!!busyAction} id="memory-draft" value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} maxLength={5000} required autoFocus />
                    <div>
                      <button className="save-action" disabled={!!busyAction}>{busyAction === "memory" ? "Saving…" : "Save interests"}</button>
                      <button type="button" className="cancel-action" disabled={!!busyAction} onClick={() => { setMemoryDraft(profile.preference_statement); setMemoryEditing(false); }}>Cancel</button>
                    </div>
                  </form>
                )}
              </> : <div className="sheet-skeleton memory-skeleton" aria-label="Loading preference memory" />}
              {memoryNotice && <p className={settingsStyles.formFeedback} data-tone={memoryNotice.tone} role={memoryNotice.tone === "error" ? "alert" : "status"}>{memoryNotice.message}</p>}
            </section>

            <section id={settings ? "sources" : "channels"} className={settings ? `${settingsStyles.taskSection} source-ledger` : "source-ledger"} aria-labelledby="sources-heading">
              <header className="section-line"><h2 id="sources-heading">Tracked sources</h2><span>{channels.length}</span></header>
              <div className="source-list">
                {channels.map((channel) => (
                  <div key={channel.id} className="source-row">
                    {channel.thumbnail_url ? <img src={channel.thumbnail_url} alt="" width="48" height="48" /> : <span className="source-fallback" aria-hidden="true">{channel.name.slice(0, 1)}</span>}
                    <a href={channel.url} target="_blank" rel="noreferrer">{channel.name}</a>
                    <button aria-label={`Remove ${channel.name}`} disabled={!!busyAction} onClick={(event) => { removalTrigger.current = event.currentTarget; if (settings) setPendingRemoval(channel); else void removeChannel(channel); }}>{busyAction === `remove-${channel.id}` ? "Removing…" : "Remove"}</button>
                    {settings && pendingRemoval?.id === channel.id && <div className={settingsStyles.removeConfirmation} role="group" aria-label={`Confirm removal of ${channel.name}`}>
                      <span>Remove {channel.name}? You can add it again later.</span>
                      <button className="cancel-action" type="button" disabled={!!busyAction} onClick={() => void removeChannel(channel)}>{busyAction === `remove-${channel.id}` ? "Removing…" : "Remove source"}</button>
                      <button className="cancel-action" type="button" autoFocus disabled={!!busyAction} onClick={() => { setPendingRemoval(null); removalTrigger.current?.focus(); }}>Cancel</button>
                    </div>}
                  </div>
                ))}
              </div>
              <form className="source-form" onSubmit={addChannel}>
                <label htmlFor="source-url">YouTube URL</label>
                <div className="source-input-row">
                  <input ref={sourceInput} id="source-url" type="url" inputMode="url" value={channelUrl} onChange={(event) => changeChannelUrl(event.target.value)} placeholder="Channel, handle, or video URL" aria-describedby="source-status" required />
                  <button disabled={!!busyAction || sourceState !== "resolved"}>{busyAction === "source" ? "Adding…" : "Add source"}</button>
                </div>
                <p id="source-status" className={`source-status ${sourceState}`} role={["invalid", "error", "duplicate"].includes(sourceState) ? "alert" : "status"}>{sourceMessage || "Paste any YouTube channel or video URL."}</p>
                {resolvedChannel && <div className="source-preview">
                  {resolvedChannel.thumbnail_url ? <img src={resolvedChannel.thumbnail_url} alt="" width="56" height="56" /> : <span className="source-fallback" aria-hidden="true">{resolvedChannel.name.slice(0, 1)}</span>}
                  <div><strong>{resolvedChannel.name}</strong><a href={resolvedChannel.url} target="_blank" rel="noreferrer">Open canonical channel</a></div>
                </div>}
              </form>
            </section>
          </aside>
        </div>
        {settings && <section id="account" className={settingsStyles.accountSection} aria-labelledby="account-settings-heading">
          <h2 id="account-settings-heading">Account & privacy</h2>
          <p>Manage your sign-in, Telegram connection, data history, export, and account deletion.</p>
          <AccountControls onAccountChange={setAccountDelivery} />
        </section>}
      </main>
    </SignalShell>
  );
}
