"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

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

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function durationLabel(seconds: number | null) {
  if (!seconds) return "Duration pending";
  return `${Math.round(seconds / 60)} min`;
}

export function FiniteFeedDashboard({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
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
      ]);
      if (responses.some((response) => !response.ok)) throw new Error("The API is not ready yet.");
      const [nextProfile, nextChannels, nextRecommendations, nextMetrics] = await Promise.all(
        responses.map((response) => response.json()),
      );
      setProfile(nextProfile);
      setChannels(nextChannels);
      setRecommendations(nextRecommendations);
      setMetrics(nextMetrics);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load Finite Feed.");
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
    if (!response.ok) return setNotice("Could not save your preferences.");
    setProfile(await response.json());
    setNotice("Preferences saved as a new, auditable version.");
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
      return setNotice(body.detail ?? "Could not add that channel.");
    }
    setChannelName("");
    setChannelUrl("");
    setNotice("Channel added to your tracked set.");
    await load();
  }

  async function removeChannel(id: string) {
    const response = await fetch(`${apiBaseUrl}/api/channels/${id}`, { method: "DELETE" });
    if (!response.ok) return setNotice("Could not remove that channel.");
    setChannels((current) => current.filter((channel) => channel.id !== id));
    setNotice("Channel removed from your tracked set.");
  }

  async function rate(id: string, rating: "up" | "down") {
    const response = await fetch(`${apiBaseUrl}/api/recommendations/${id}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating }),
    });
    if (!response.ok) return setNotice("Could not record that feedback.");
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
      return setNotice(body.detail ?? "Could not generate a recommendation.");
    }
    setNotice("A new recommendation is ready.");
    await load();
  }

  if (!apiBaseUrl) {
    return <main className="setup-state">Set NEXT_PUBLIC_API_BASE_URL to connect this dashboard.</main>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="Finite Feed home">
          <span className="brand-mark">F</span>
          <span>Finite Feed</span>
        </a>
        <nav aria-label="Dashboard sections">
          <a className="active" href="#recommendations">Today</a>
          <a href="#preferences">Preferences</a>
          <a href="#channels">Sources</a>
          <a href="#signals">Signals</a>
        </nav>
        <div className="sidebar-note">
          <span className="live-dot" />
          <div><strong>Twice weekly</strong><small>Next send · 9:00 AM</small></div>
        </div>
      </aside>

      <main id="top" className="dashboard">
        <header className="topbar">
          <div>
            <p className="kicker">Your high-signal queue</p>
            <h1>One idea worth your time.</h1>
          </div>
          <button className="primary" onClick={() => void generate()} disabled={busy}>Find one now <span>→</span></button>
        </header>

        {notice && <p className="notice" role="status">{notice}</p>}

        <section id="recommendations" className="feature-section">
          <div className="section-heading">
            <div><span className="section-number">01</span><h2>Latest recommendation</h2></div>
            <p>Selected from your tracked talks</p>
          </div>
          {recommendations.length ? (
            <article className="recommendation-card">
              <div className="video-art"><span>▶</span><small>{durationLabel(recommendations[0].duration_seconds)}</small></div>
              <div className="recommendation-copy">
                <p className="meta">{recommendations[0].channel_name} · {recommendations[0].published_at ? new Date(recommendations[0].published_at).toLocaleDateString() : "Recently added"}</p>
                <h3>{recommendations[0].title}</h3>
                {recommendations[0].speaker && <p className="speaker">with {recommendations[0].speaker}</p>}
                <p className="rationale">{recommendations[0].rationale}</p>
                <div className="actions">
                  <a className="watch" href={`${apiBaseUrl}/r/${recommendations[0].id}`} target="_blank" rel="noreferrer">Watch on YouTube ↗</a>
                  <button className={recommendations[0].rating === "up" ? "rated" : "icon-button"} onClick={() => void rate(recommendations[0].id, "up")} aria-label="More like this">↑</button>
                  <button className={recommendations[0].rating === "down" ? "rated" : "icon-button"} onClick={() => void rate(recommendations[0].id, "down")} aria-label="Less like this">↓</button>
                </div>
              </div>
            </article>
          ) : (
            <div className="empty-card"><span>◎</span><h3>Your first pick is waiting.</h3><p>Add provider keys to ingest talks, then ask Finite Feed to choose one.</p></div>
          )}
        </section>

        <div className="two-column">
          <section id="preferences" className="panel">
            <div className="section-heading compact"><div><span className="section-number">02</span><h2>Your filter</h2></div>{profile && <em>v{profile.version}</em>}</div>
            {profile ? (
              <form onSubmit={saveProfile}>
                <label htmlFor="preference">What should feel unusually valuable?</label>
                <textarea id="preference" value={profile.preference_statement} onChange={(event) => setProfile({ ...profile, preference_statement: event.target.value })} maxLength={5000} required />
                <div className="schedule-row">
                  <label>Delivery days</label>
                  <div className="day-picker">{days.map((day, index) => <button type="button" key={day} className={profile.cadence_days.includes(index) ? "selected" : ""} onClick={() => setProfile({ ...profile, cadence_days: profile.cadence_days.includes(index) ? profile.cadence_days.filter((value) => value !== index) : [...profile.cadence_days, index] })}>{day[0]}</button>)}</div>
                </div>
                <div className="form-footer"><span>Every edit creates a recoverable version.</span><button className="secondary" disabled={busy}>Save filter</button></div>
              </form>
            ) : <div className="skeleton" />}
          </section>

          <section id="signals" className="panel signals">
            <div className="section-heading compact"><div><span className="section-number">03</span><h2>Signal quality</h2></div></div>
            <div className="metric-grid">
              <div><strong>{metrics ? `${Math.round(metrics.thumbs_up_share * 100)}%` : "—"}</strong><span>positive ratings</span></div>
              <div><strong>{metrics ? `${Math.round(metrics.click_through_rate * 100)}%` : "—"}</strong><span>unique clicks</span></div>
              <div><strong>{metrics?.delivered ?? "—"}</strong><span>delivered</span></div>
              <div><strong>{metrics ? metrics.rated_up + metrics.rated_down : "—"}</strong><span>rated</span></div>
            </div>
            <p className="metric-note">Goals: 2:1 positive feedback and more than 50% unique clicks.</p>
          </section>
        </div>

        <section id="channels" className="panel channels-panel">
          <div className="section-heading compact"><div><span className="section-number">04</span><h2>Tracked sources</h2></div><span>{channels.length} channels</span></div>
          <div className="channel-list">
            {channels.map((channel) => <div className="channel" key={channel.id}><span className="channel-avatar">{channel.name.slice(0, 1)}</span><div><strong>{channel.name}</strong><a href={channel.url} target="_blank" rel="noreferrer">{channel.url.replace("https://www.youtube.com/", "")}</a></div>{channel.is_default ? <em>Default</em> : <button onClick={() => void removeChannel(channel.id)} aria-label={`Remove ${channel.name}`}>Remove</button>}</div>)}
          </div>
          <form className="channel-form" onSubmit={addChannel}>
            <input aria-label="Channel name" placeholder="Channel name" value={channelName} onChange={(event) => setChannelName(event.target.value)} required />
            <input aria-label="YouTube channel URL" type="url" placeholder="https://youtube.com/@channel" value={channelUrl} onChange={(event) => setChannelUrl(event.target.value)} required />
            <button disabled={busy}>Add source</button>
          </form>
        </section>
      </main>
    </div>
  );
}
