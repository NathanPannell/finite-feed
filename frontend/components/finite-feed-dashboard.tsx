"use client";

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

type Channel = {
  id: string;
  name: string;
  url: string;
  is_default: boolean;
};

type Recommendation = {
  id: string;
  title: string;
  speaker: string | null;
  channel_name: string;
  youtube_url: string;
  published_at: string | null;
  duration_seconds: number | null;
  rationale: string;
  rating: "up" | "down" | null;
  clicked_at: string | null;
  created_at: string;
};

type Metrics = {
  delivered: number;
  clicked: number;
  rated_up: number;
  rated_down: number;
  click_through_rate: number;
  thumbs_up_share: number;
};

type PipelineStatus = {
  videos: number;
  embedded_videos: number;
  last_ingestion_status: string | null;
  last_ingestion_at: string | null;
};

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function durationLabel(seconds: number | null) {
  if (!seconds) return "Duration pending";
  return `${Math.round(seconds / 60)} min`;
}

function shortDate(date: string | null) {
  if (!date) return "Recently added";
  return new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function FiniteFeedDashboard({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [channelName, setChannelName] = useState("");
  const [channelUrl, setChannelUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!apiBaseUrl) return;
    try {
      const responses = await Promise.all([
        fetch(`${apiBaseUrl}/api/profile`, { cache: "no-store" }),
        fetch(`${apiBaseUrl}/api/channels`, { cache: "no-store" }),
        fetch(`${apiBaseUrl}/api/recommendations`, { cache: "no-store" }),
        fetch(`${apiBaseUrl}/api/metrics`, { cache: "no-store" }),
        fetch(`${apiBaseUrl}/api/pipeline/status`, { cache: "no-store" }),
      ]);
      if (responses.some((response) => !response.ok)) throw new Error("The feed could not reach its source. Try again in a moment.");
      const [nextProfile, nextChannels, nextRecommendations, nextMetrics, nextPipeline] = await Promise.all(
        responses.map((response) => response.json()),
      );
      setProfile(nextProfile);
      setChannels(nextChannels);
      setRecommendations(nextRecommendations);
      setMetrics(nextMetrics);
      setPipeline(nextPipeline);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load Finite Feed. Try again.");
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile) return;
    setBusy(true);
    const response = await fetch(`${apiBaseUrl}/api/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });
    setBusy(false);
    if (!response.ok) return setNotice("Preferences were not saved. Check the fields and try again.");
    setProfile(await response.json());
    setNotice("Preferences saved as a new, recoverable version.");
  }

  async function addChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const response = await fetch(`${apiBaseUrl}/api/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: channelName, url: channelUrl }),
    });
    setBusy(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return setNotice(body.detail ?? "That source was not added. Check the URL and try again.");
    }
    setChannelName("");
    setChannelUrl("");
    setNotice("Source added to the tracked set.");
    await load();
  }

  async function removeChannel(id: string) {
    const response = await fetch(`${apiBaseUrl}/api/channels/${id}`, { method: "DELETE" });
    if (!response.ok) return setNotice("That source was not removed. Try again.");
    setChannels((current) => current.filter((channel) => channel.id !== id));
    setNotice("Source removed from the tracked set.");
  }

  async function rate(id: string, rating: "up" | "down") {
    const response = await fetch(`${apiBaseUrl}/api/recommendations/${id}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating }),
    });
    if (!response.ok) return setNotice("Feedback was not recorded. Try again.");
    const updated = await response.json();
    setRecommendations((current) => current.map((item) => (item.id === id ? updated : item)));
    setNotice(rating === "up" ? "Saved — more like this." : "Saved — less like this.");
  }

  async function generate() {
    setBusy(true);
    const response = await fetch(`${apiBaseUrl}/api/recommendations/generate`, { method: "POST" });
    setBusy(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return setNotice(body.detail ?? "A new recommendation could not be made. Try again.");
    }
    setNotice("A new recommendation is ready.");
    await load();
  }

  if (!apiBaseUrl) {
    return <main className="setup-state">Set NEXT_PUBLIC_API_BASE_URL to connect this feed.</main>;
  }

  const latest = recommendations[0];

  return (
    <SignalShell active="feed">
      <main id="top" className="public-main">
        <header className="public-hero">
          <h1>Fewer things.<br /><span>Better chosen.</span></h1>
          <div>
            <p>One unusually valuable talk at a time, selected from the sources and ideas you trust.</p>
            <button className="signal-action" onClick={() => void generate()} disabled={busy}>
              {busy ? "Choosing…" : "Choose one now"}
            </button>
          </div>
        </header>

        {notice && <p className="signal-notice" role="status">{notice}</p>}

        <div className="reading-grid">
          <section id="recommendations" className="feed-column" aria-labelledby="recommendations-heading">
            <header className="section-line">
              <h2 id="recommendations-heading">For you</h2>
              <span>{recommendations.length ? `${recommendations.length} recent` : "Queue open"}</span>
            </header>

            {latest ? (
              <article className="lead-recommendation">
                <p className="recommendation-meta">
                  <span>{latest.channel_name}</span>
                  <span>{durationLabel(latest.duration_seconds)}</span>
                  <time dateTime={latest.published_at ?? undefined}>{shortDate(latest.published_at)}</time>
                </p>
                <h3>{latest.title}</h3>
                {latest.speaker && <p className="recommendation-speaker">with {latest.speaker}</p>}
                <p className="recommendation-rationale">{latest.rationale}</p>
                <footer className="recommendation-actions">
                  <a className="watch-action" href={`${apiBaseUrl}/r/${latest.id}`} target="_blank" rel="noreferrer">Watch on YouTube</a>
                  <div role="group" aria-label="Rate this recommendation">
                    <button className="fit-action" aria-pressed={latest.rating === "up"} onClick={() => void rate(latest.id, "up")}>Useful</button>
                    <button className="fit-action" aria-pressed={latest.rating === "down"} onClick={() => void rate(latest.id, "down")}>Missed</button>
                  </div>
                </footer>
              </article>
            ) : (
              <div className="signal-empty">
                <h3>Your first pick is being edited.</h3>
                <p>{pipeline?.embedded_videos ? `${pipeline.embedded_videos} talks are indexed and ready to compare.` : "The worker is preparing the first TED and TEDx candidates."}</p>
              </div>
            )}

            {recommendations.length > 1 && (
              <div className="recommendation-ledger" aria-label="Recent recommendations">
                {recommendations.slice(1, 7).map((item) => (
                  <article key={item.id} className="ledger-row">
                    <div>
                      <p>{item.channel_name} · {durationLabel(item.duration_seconds)}</p>
                      <h3>{item.title}</h3>
                      <span>{item.rationale}</span>
                    </div>
                    <div className="ledger-response">
                      <time dateTime={item.created_at}>{shortDate(item.created_at)}</time>
                      <div role="group" aria-label={`Rate ${item.title}`}>
                        <button aria-pressed={item.rating === "up"} onClick={() => void rate(item.id, "up")}>Useful</button>
                        <button aria-pressed={item.rating === "down"} onClick={() => void rate(item.id, "down")}>Missed</button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <aside className="memory-column">
            <section id="preferences" className="preference-sheet" aria-labelledby="preferences-heading">
              <header className="section-line">
                <h2 id="preferences-heading">Preference memory</h2>
                {profile && <span>Version {profile.version}</span>}
              </header>
              {profile ? (
                <form onSubmit={saveProfile}>
                  <label htmlFor="preference">What should feel unusually valuable?</label>
                  <textarea id="preference" value={profile.preference_statement} onChange={(event) => setProfile({ ...profile, preference_statement: event.target.value })} maxLength={5000} required />
                  <fieldset className="day-fieldset">
                    <legend>Delivery days</legend>
                    <div className="day-picker">{days.map((day, index) => (
                      <button type="button" key={day} aria-pressed={profile.cadence_days.includes(index)} onClick={() => setProfile({ ...profile, cadence_days: profile.cadence_days.includes(index) ? profile.cadence_days.filter((value) => value !== index) : [...profile.cadence_days, index] })}>{day.slice(0, 2)}</button>
                    ))}</div>
                  </fieldset>
                  <div className="delivery-fields">
                    <label>Hour<input type="number" min="0" max="23" value={profile.delivery_hour} onChange={(event) => setProfile({ ...profile, delivery_hour: Number(event.target.value) })} /></label>
                    <label>Time zone<input value={profile.timezone} onChange={(event) => setProfile({ ...profile, timezone: event.target.value })} /></label>
                    <label>Picks<input type="number" min="1" max="5" value={profile.recommendation_count} onChange={(event) => setProfile({ ...profile, recommendation_count: Number(event.target.value) })} /></label>
                  </div>
                  <button className="save-action" disabled={busy}>{busy ? "Saving…" : "Shape my feed"}</button>
                </form>
              ) : <div className="sheet-skeleton" aria-label="Loading preference memory" />}
            </section>

            <section id="signals" className="quality-ledger" aria-labelledby="quality-heading">
              <header className="section-line"><h2 id="quality-heading">Signal quality</h2></header>
              <dl>
                <div><dt>Positive ratings</dt><dd>{metrics ? `${Math.round(metrics.thumbs_up_share * 100)}%` : "—"}</dd></div>
                <div><dt>Unique clicks</dt><dd>{metrics ? `${Math.round(metrics.click_through_rate * 100)}%` : "—"}</dd></div>
                <div><dt>Talks indexed</dt><dd>{pipeline?.embedded_videos ?? "—"}</dd></div>
                <div><dt>Worker sync</dt><dd>{pipeline?.last_ingestion_status ?? "Waiting"}</dd></div>
              </dl>
              <a className="quality-action" href="/match">Open Match Lab</a>
            </section>

            <section id="channels" className="source-ledger" aria-labelledby="sources-heading">
              <header className="section-line"><h2 id="sources-heading">Tracked sources</h2><span>{channels.length}</span></header>
              <div>
                {channels.map((channel) => (
                  <p key={channel.id}><a href={channel.url} target="_blank" rel="noreferrer">{channel.name}</a>{channel.is_default ? <span>Default</span> : <button aria-label={"Remove " + channel.name} onClick={() => void removeChannel(channel.id)}>Remove</button>}</p>
                ))}
              </div>
              <form onSubmit={addChannel}>
                <label><span>Channel name</span><input value={channelName} onChange={(event) => setChannelName(event.target.value)} required /></label>
                <label><span>YouTube URL</span><input type="url" value={channelUrl} onChange={(event) => setChannelUrl(event.target.value)} required /></label>
                <button disabled={busy}>Add source</button>
              </form>
            </section>
          </aside>
        </div>
      </main>
    </SignalShell>
  );
}
