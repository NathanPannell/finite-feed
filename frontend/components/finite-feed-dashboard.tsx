"use client";

/* eslint-disable @next/next/no-img-element -- YouTube supplies dynamic external image hosts. */

import { FormEvent, useCallback, useEffect, useState } from "react";
import { SignalShell } from "@/components/signal-shell";

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

async function responseMessage(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  if (body && typeof body === "object" && typeof body.detail === "string") return body.detail;
  return fallback;
}

export function FiniteFeedDashboard({ apiBaseUrl }: { apiBaseUrl: string }) {
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

  const load = useCallback(async () => {
    if (!apiBaseUrl) return;
    setLoading(true);
    try {
      const responses = await Promise.all([
        fetch(`${apiBaseUrl}/api/profile`, { cache: "no-store" }),
        fetch(`${apiBaseUrl}/api/channels`, { cache: "no-store" }),
        fetch(`${apiBaseUrl}/api/recommendations`, { cache: "no-store" }),
      ]);
      if (responses.some((response) => !response.ok)) throw new Error("The feed could not reach its source. Try again in a moment.");
      const [nextProfile, nextChannels, nextRecommendations] = await Promise.all(responses.map((response) => response.json()));
      setProfile(nextProfile);
      setMemoryDraft(nextProfile.preference_statement);
      setChannels(nextChannels);
      setRecommendations(nextRecommendations);
      setNotice(null);
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : "Could not load Finite Feed. Try again.", tone: "error" });
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl]);

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
        const response = await fetch(`${apiBaseUrl}/api/channels/resolve`, {
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
    if (!profile) return;
    setBusyAction("delivery");
    try {
      const response = await fetch(`${apiBaseUrl}/api/profile/delivery`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cadence_days: profile.cadence_days,
          recommendation_count: profile.recommendation_count,
        }),
      });
      if (!response.ok) {
        setNotice({ message: "Delivery preferences were not saved. Try again.", tone: "error" });
        return;
      }
      const saved = (await response.json()) as Profile;
      setProfile(saved);
      setNotice({ message: "Delivery preferences saved.", tone: "success" });
    } catch {
      setNotice({ message: "Delivery preferences were not saved. Check your connection and try again.", tone: "error" });
    } finally {
      setBusyAction(null);
    }
  }

  async function saveMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    setBusyAction("memory");
    try {
      const response = await fetch(`${apiBaseUrl}/api/profile/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preference_statement: memoryDraft, expected_version: profile.version }),
      });
      if (!response.ok) {
        setNotice({
          message: response.status === 409
            ? "Preference memory changed elsewhere. Reload and try again."
            : "Preference memory was not saved. Check the field and try again.",
          tone: "error",
        });
        return;
      }
      const saved = (await response.json()) as Profile;
      setProfile(saved);
      setMemoryDraft(saved.preference_statement);
      setMemoryEditing(false);
      setNotice({ message: "Preference memory saved.", tone: "success" });
    } catch {
      setNotice({ message: "Preference memory was not saved. Check your connection and try again.", tone: "error" });
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
    if (!resolvedChannel || sourceState !== "resolved") return;
    setBusyAction("source");
    try {
      const response = await fetch(`${apiBaseUrl}/api/channels`, {
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
    setBusyAction(`remove-${channel.id}`);
    try {
      const response = await fetch(`${apiBaseUrl}/api/channels/${channel.id}`, { method: "DELETE" });
      if (!response.ok) {
        setNotice({ message: `${channel.name} was not removed. Try again.`, tone: "error" });
        return;
      }
      setChannels((current) => current.filter((item) => item.id !== channel.id));
      setNotice({ message: `${channel.name} is no longer tracked.`, tone: "success" });
    } catch {
      setNotice({ message: `${channel.name} was not removed. Check your connection and try again.`, tone: "error" });
    } finally {
      setBusyAction(null);
    }
  }

  async function rate(id: string, rating: "up" | "down") {
    setBusyAction(`rate-${id}`);
    try {
      const response = await fetch(`${apiBaseUrl}/api/recommendations/${id}/feedback`, {
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
      const response = await fetch(`${apiBaseUrl}/api/recommendations/generate`, { method: "POST" });
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

  if (!apiBaseUrl) return <main className="setup-state">Set NEXT_PUBLIC_API_BASE_URL to connect this feed.</main>;

  return (
    <SignalShell active="feed">
      <main id="top" className="public-main">
        <header className="public-hero">
          <h1>Fewer things.<br /><span>Better chosen.</span></h1>
          <p>One unusually valuable talk at a time, selected from the sources and ideas you trust.</p>
          <button className="signal-action" onClick={() => void generate()} disabled={busyAction === "generate"}>
            {busyAction === "generate" ? "Choosing…" : "Choose one now"}
          </button>
        </header>

        {notice && <p className={notice.tone === "error" ? "signal-error" : "signal-notice"} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p>}

        <div className="reading-grid">
          <section id="recommendations" className="feed-column" aria-labelledby="recommendations-heading">
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
                <h3>Your first pick is being edited.</h3>
                <p>Check back after the next source refresh or choose one now.</p>
              </div>
            )}
          </section>

          <aside className="memory-column">
            <section id="preferences" className="delivery-sheet" aria-labelledby="delivery-heading">
              <header className="section-line"><h2 id="delivery-heading">Delivery preferences</h2></header>
              {profile ? (
                <form className="delivery-form" onSubmit={saveDelivery}>
                  <fieldset className="day-fieldset">
                    <legend>Delivery days</legend>
                    <div className="day-picker">{days.map((day, index) => {
                      const selected = profile.cadence_days.includes(index);
                      return <button type="button" key={day} aria-pressed={selected} onClick={() => {
                        if (selected && profile.cadence_days.length === 1) {
                          setNotice({ message: "Keep at least one delivery day selected.", tone: "error" });
                          return;
                        }
                        setProfile({ ...profile, cadence_days: selected ? profile.cadence_days.filter((value) => value !== index) : [...profile.cadence_days, index].sort() });
                      }}>{day.slice(0, 2)}</button>;
                    })}</div>
                  </fieldset>
                  <div className="picks-setting">
                    <span id="picks-label">Picks per delivery</span>
                    <div className="picks-stepper" role="group" aria-labelledby="picks-label">
                      <button type="button" aria-label="Decrease picks" disabled={profile.recommendation_count <= minimumPicks} onClick={() => setProfile({ ...profile, recommendation_count: Math.max(minimumPicks, profile.recommendation_count - 1) })}>−</button>
                      <output aria-live="polite" aria-label={`${profile.recommendation_count} picks`}>{profile.recommendation_count}</output>
                      <button type="button" aria-label="Increase picks" disabled={profile.recommendation_count >= maximumPicks} onClick={() => setProfile({ ...profile, recommendation_count: Math.min(maximumPicks, profile.recommendation_count + 1) })}>+</button>
                    </div>
                  </div>
                  <button className="save-action" disabled={busyAction === "delivery"}>{busyAction === "delivery" ? "Saving…" : "Save preferences"}</button>
                </form>
              ) : <div className="sheet-skeleton" aria-label="Loading delivery preferences" />}
            </section>

            <section className="preference-memory" aria-labelledby="memory-heading">
              <header className="section-line"><h2 id="memory-heading">Preference memory</h2>{profile && <span>Version {profile.version}</span>}</header>
              {profile ? <>
                <p className="memory-summary">{profile.preference_statement}</p>
                {!memoryEditing ? (
                  <button className="memory-action" onClick={() => setMemoryEditing(true)}>Shape memory</button>
                ) : (
                  <form className="memory-editor" onSubmit={saveMemory}>
                    <label htmlFor="memory-draft">Update preference memory</label>
                    <textarea id="memory-draft" value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} maxLength={5000} required autoFocus />
                    <div>
                      <button className="save-action" disabled={busyAction === "memory"}>{busyAction === "memory" ? "Saving…" : "Save memory"}</button>
                      <button type="button" className="cancel-action" onClick={() => { setMemoryDraft(profile.preference_statement); setMemoryEditing(false); }}>Cancel</button>
                    </div>
                  </form>
                )}
              </> : <div className="sheet-skeleton memory-skeleton" aria-label="Loading preference memory" />}
            </section>

            <section id="channels" className="source-ledger" aria-labelledby="sources-heading">
              <header className="section-line"><h2 id="sources-heading">Tracked sources</h2><span>{channels.length}</span></header>
              <div className="source-list">
                {channels.map((channel) => (
                  <div key={channel.id} className="source-row">
                    {channel.thumbnail_url ? <img src={channel.thumbnail_url} alt="" width="48" height="48" /> : <span className="source-fallback" aria-hidden="true">{channel.name.slice(0, 1)}</span>}
                    <a href={channel.url} target="_blank" rel="noreferrer">{channel.name}</a>
                    <button aria-label={`Remove ${channel.name}`} disabled={busyAction === `remove-${channel.id}`} onClick={() => void removeChannel(channel)}>{busyAction === `remove-${channel.id}` ? "Removing…" : "Remove"}</button>
                  </div>
                ))}
              </div>
              <form className="source-form" onSubmit={addChannel}>
                <label htmlFor="source-url">YouTube URL</label>
                <div className="source-input-row">
                  <input id="source-url" type="url" inputMode="url" value={channelUrl} onChange={(event) => changeChannelUrl(event.target.value)} placeholder="Channel, handle, or video URL" aria-describedby="source-status" required />
                  <button disabled={busyAction === "source" || sourceState !== "resolved"}>{busyAction === "source" ? "Adding…" : "Add source"}</button>
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
      </main>
    </SignalShell>
  );
}
