/* eslint-disable @next/next/no-img-element -- YouTube thumbnails come from runtime API records. */
"use client";

import {
  FormEvent,
  ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SignalShell } from "@/components/signal-shell";
import { AdminApiError, adminRequest, JsonRecord, pageResult, PageResult } from "@/lib/admin-api";
import styles from "./admin-dashboard.module.css";

type Tab = "channels" | "videos" | "recommendations";
type DetailState = { kind: Tab; item: JsonRecord } | null;

const pageSize = 25;
const emptyPage: PageResult = { items: [], total: 0, page: 1, pageSize };

function value(record: JsonRecord | null, ...keys: string[]) {
  for (const key of keys) {
    const candidate = record?.[key];
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return null;
}

function text(record: JsonRecord | null, ...keys: string[]) {
  const candidate = value(record, ...keys);
  return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : "";
}

function numberValue(record: JsonRecord | null, ...keys: string[]) {
  const candidate = value(record, ...keys);
  return typeof candidate === "number" ? candidate : Number(candidate ?? 0) || 0;
}

function booleanValue(record: JsonRecord | null, ...keys: string[]) {
  const candidate = value(record, ...keys);
  return candidate === true || candidate === "true" || candidate === 1;
}

function localTime(candidate: unknown, fallback = "Not recorded") {
  if (typeof candidate !== "string" || !candidate) return fallback;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) return candidate;
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function compactDateTime(candidate: unknown, fallback = "Not recorded") {
  if (!candidate) return fallback;
  const parsed = new Date(String(candidate));
  if (Number.isNaN(parsed.getTime())) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function compactDay(candidate: unknown) {
  if (!candidate) return "—";
  const parsed = new Date(`${String(candidate)}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(parsed);
}

function duration(candidate: unknown) {
  const seconds = Number(candidate);
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function compactNumber(candidate: unknown) {
  const amount = Number(candidate);
  return Number.isFinite(amount) ? new Intl.NumberFormat(undefined, { notation: "compact" }).format(amount) : "—";
}

function statusTone(label: string) {
  const normalized = label.toLowerCase();
  if (/error|fail|inactive|stopped|down/.test(normalized)) return "danger";
  if (/queue|pending|backfill|running|progress/.test(normalized)) return "pending";
  if (/active|complete|success|delivered|up/.test(normalized)) return "success";
  return "neutral";
}

function Status({ children }: { children: ReactNode }) {
  const label = String(children || "Unknown");
  return <span className={`admin-status ${statusTone(label)}`}><i aria-hidden="true" />{label}</span>;
}

function Icon({ name }: { name: "refresh" | "close" | "arrow" | "search" | "minus" | "plus" }) {
  const paths = {
    refresh: <><path d="M20 11a8 8 0 1 0-2.34 5.66" /><path d="M20 4v7h-7" /></>,
    close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
    minus: <path d="M6 12h12" />,
    plus: <><path d="M6 12h12" /><path d="M12 6v12" /></>,
  };
  return <svg aria-hidden="true" className="admin-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function isChannelUrl(candidate: string) {
  try {
    const url = new URL(candidate);
    return /(^|\.)youtube\.com$/i.test(url.hostname) && (/^\/@[^/]+\/?$/.test(url.pathname) || /^\/channel\/[\w-]+\/?$/.test(url.pathname));
  } catch {
    return false;
  }
}

function requestMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.name === "AbortError") return "";
  return error instanceof Error ? error.message : fallback;
}

const detailPriority: Record<Tab, string[]> = {
  channels: ["name", "canonical_url", "is_active", "sync_status", "last_sync_completed_at", "max_video_age_days", "ingested_video_count"],
  videos: ["title", "channel_name", "youtube_url", "published_at", "duration_seconds", "view_count", "embedding_model", "recommendation_count"],
  recommendations: ["recipient_name", "video_title", "channel_name", "rationale", "delivery_state", "rating", "created_at", "delivered_at", "clicked_at"],
};

const detailLabels: Record<string, string> = {
  canonical_url: "YouTube channel",
  is_active: "Tracking",
  sync_status: "Latest sync",
  last_sync_completed_at: "Last synced",
  max_video_age_days: "Video window",
  ingested_video_count: "Stored videos",
  youtube_url: "YouTube video",
  published_at: "Published",
  duration_seconds: "Duration",
  view_count: "Views",
  embedding_model: "Search index",
  recommendation_count: "Recommendations",
  recipient_name: "Recipient",
  video_title: "Video",
  delivery_state: "Delivery",
  created_at: "Created",
  delivered_at: "Delivered",
  clicked_at: "Clicked",
};

function detailLabel(key: string) {
  return detailLabels[key] || key.replaceAll("_", " ");
}

function DetailsValue({ data, field }: { data: unknown; field?: string }) {
  if (data === null || data === undefined || data === "") return <span className="admin-null">Not recorded</span>;
  if (field === "is_active") return <Status>{data ? "Active" : "Paused"}</Status>;
  if (typeof data === "boolean") return <span>{data ? "Yes" : "No"}</span>;
  if (field === "duration_seconds") return <span>{duration(data)}</span>;
  if (field && /(_at|_date)$/.test(field)) return <time title={String(data)}>{localTime(data)}</time>;
  if (field && /(_count|view_count)$/.test(field) && Number.isFinite(Number(data))) return <span>{Number(data).toLocaleString()}</span>;
  if (typeof data === "object") {
    return <details><summary>Inspect structured value</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>;
  }
  const candidate = String(data);
  if (candidate.length > 180) return <details><summary>Read full value</summary><pre className="admin-long-text">{candidate}</pre></details>;
  if (/^https?:\/\//.test(candidate)) return <a href={candidate} target="_blank" rel="noreferrer">{candidate}</a>;
  return <span>{candidate}</span>;
}

function RecordModal({ state, close, closeRef }: { state: DetailState; close: () => void; closeRef: RefObject<HTMLButtonElement | null> }) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!state) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'))
        .filter((element) => {
          if (!element.getClientRects().length || getComputedStyle(element).visibility === "hidden") return false;
          let closedDetails = element.parentElement?.closest("details:not([open])");
          while (closedDetails) {
            if (!closedDetails.querySelector(":scope > summary")?.contains(element)) return false;
            closedDetails = closedDetails.parentElement?.closest("details:not([open])");
          }
          return true;
        });
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [close, closeRef, state]);

  if (!state) return null;
  const entries = Object.entries(state.item).filter(([key]) => state.kind !== "channels" || !["user_id", "owner_name"].includes(key));
  const preferred = detailPriority[state.kind];
  const primaryEntries = preferred.flatMap((key) => {
    const entry = entries.find(([candidate]) => candidate === key);
    return entry ? [entry] : [];
  });
  const diagnosticEntries = entries.filter(([key]) => !preferred.includes(key));
  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section ref={dialogRef} className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="record-title">
        <header>
          <div><p>{state.kind.slice(0, -1)} record</p><h2 id="record-title">{text(state.item, "name", "title", "event_type", "id") || "Record details"}</h2></div>
          <button ref={closeRef} className="admin-icon-button" onClick={close} aria-label="Close details"><Icon name="close" /></button>
        </header>
        <div className="admin-detail-list">
          {primaryEntries.map(([key, data]) => (
            <div key={key}><dt>{detailLabel(key)}</dt><dd><DetailsValue data={data} field={key} /></dd></div>
          ))}
          {diagnosticEntries.length > 0 && <details className="admin-diagnostics">
            <summary>Technical details <span>{diagnosticEntries.length}</span></summary>
            <dl>{diagnosticEntries.map(([key, data]) => <div key={key}><dt>{detailLabel(key)}</dt><dd><DetailsValue data={data} field={key} /></dd></div>)}</dl>
          </details>}
        </div>
      </section>
    </div>
  );
}

function LoadingRows({ columns }: { columns: number }) {
  return <>{[0, 1, 2, 3].map((row) => <tr key={row} className="admin-loading-row" aria-hidden="true">{Array.from({ length: columns }, (_, column) => <td key={column}><span /></td>)}</tr>)}</>;
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return <div className="admin-empty"><span aria-hidden="true" /><h3>{title}</h3><p>{message}</p></div>;
}

function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <div className="admin-error" role="alert"><div><strong>Couldn’t load this view.</strong><p>{message}</p></div><button className="admin-secondary" onClick={retry}>Try again</button></div>;
}

function Pagination({ data, go }: { data: PageResult; go: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return <footer className="admin-pagination"><span>{data.total ? `${(data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.total)} of ${data.total}` : "0 records"}</span><div><button onClick={() => go(data.page - 1)} disabled={data.page <= 1}>Previous</button><span>Page {data.page} of {pages}</span><button onClick={() => go(data.page + 1)} disabled={data.page >= pages}>Next</button></div>
  </footer>;
}

function ChannelAgeControl({ item, save }: { item: JsonRecord; save: (item: JsonRecord, patch: JsonRecord) => void }) {
  const initial = numberValue(item, "max_video_age_days") || 7;
  const [age, setAge] = useState(initial);
  return <form className="admin-age-form" onSubmit={(event) => { event.preventDefault(); save(item, { max_video_age_days: age }); }}>
    <NumberStepper label={`Video window for ${text(item, "name")}`} value={age} setValue={setAge} min={1} max={365} unit="days" compact />
    <button disabled={age === initial}>Save</button>
  </form>;
}

function NumberStepper({ label, value, setValue, min, max, unit, compact = false }: { label: string; value: number; setValue: (value: number) => void; min: number; max: number; unit: string; compact?: boolean }) {
  const clamp = (next: number) => setValue(Math.min(max, Math.max(min, next)));
  return <div className={`admin-number-stepper ${compact ? "compact" : ""}`}>
    <button type="button" aria-label={`Decrease ${label}`} onClick={() => clamp(value - 1)} disabled={value <= min}><Icon name="minus" /></button>
    <label><span className="sr-only">{label}</span><input type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(event) => clamp(Number(event.target.value))} /></label>
    <span aria-hidden="true">{unit}</span>
    <button type="button" aria-label={`Increase ${label}`} onClick={() => clamp(value + 1)} disabled={value >= max}><Icon name="plus" /></button>
  </div>;
}

function chartPoints(values: number[], maximum: number) {
  const denominator = Math.max(values.length - 1, 1);
  return values.map((item, index) => {
    const x = 18 + (index / denominator) * 564;
    const y = 154 - (item / Math.max(maximum, 1)) * 132;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function PerformanceChart({ data }: { data: JsonRecord[] }) {
  if (!data.length) return <EmptyState title="No performance data" message="Delivered recommendations will establish the trend." />;
  const up = data.map((item) => numberValue(item, "up_count"));
  const down = data.map((item) => numberValue(item, "down_count"));
  const share = data.map((item) => numberValue(item, "up_share") * 100);
  const countMaximum = Math.max(...up, ...down, 1);
  const firstDay = compactDay(value(data[0], "day"));
  const lastDay = compactDay(value(data[data.length - 1], "day"));
  return <div className="admin-performance-grid">
    <figure>
      <figcaption><strong>Feedback</strong><span><i className="up" />Useful <i className="down" />Not useful</span></figcaption>
      <svg viewBox="0 0 600 176" role="img" aria-labelledby="feedback-chart-title feedback-chart-description">
        <title id="feedback-chart-title">Useful and not useful feedback over time</title>
        <desc id="feedback-chart-description">Daily feedback counts from {firstDay} through {lastDay}.</desc>
        <path className="chart-grid" d="M18 22H582M18 88H582M18 154H582" />
        <polyline className="chart-line up" points={chartPoints(up, countMaximum)} />
        <polyline className="chart-line down" points={chartPoints(down, countMaximum)} />
      </svg>
      <div className="chart-axis"><span>{firstDay}</span><span>{lastDay}</span></div>
    </figure>
    <figure>
      <figcaption><strong>Useful share</strong><span>of recommendations sent</span></figcaption>
      <svg viewBox="0 0 600 176" role="img" aria-labelledby="share-chart-title share-chart-description">
        <title id="share-chart-title">Useful feedback as a share of recommendations sent</title>
        <desc id="share-chart-description">Daily percentage from {firstDay} through {lastDay}.</desc>
        <path className="chart-grid" d="M18 22H582M18 88H582M18 154H582" />
        <polyline className="chart-line share" points={chartPoints(share, 100)} />
      </svg>
      <div className="chart-axis"><span>{firstDay}</span><span>{lastDay}</span></div>
    </figure>
    <div className="admin-performance-table-wrap">
      <table className="admin-performance-table">
        <caption>Daily feedback data</caption>
        <thead><tr><th>Date</th><th>Useful</th><th>Not useful</th><th>Sent</th><th>Useful share</th></tr></thead>
        <tbody>{data.map((item) => <tr key={text(item, "day")}><td><time dateTime={text(item, "day")}>{compactDay(value(item, "day"))}</time></td><td>{numberValue(item, "up_count")}</td><td>{numberValue(item, "down_count")}</td><td>{numberValue(item, "sent_count")}</td><td>{Math.round(numberValue(item, "up_share") * 100)}%</td></tr>)}</tbody>
      </table>
    </div>
  </div>;
}

function RecommendationTimeline({ item }: { item: JsonRecord }) {
  const lastInteractionType = text(item, "last_interaction_type");
  const lastInteractionAt = value(item, "last_interacted_at");
  const events = [
    { label: "Created", at: value(item, "created_at") },
    { label: "Delivered", at: value(item, "delivered_at") },
    { label: "Clicked", at: value(item, "clicked_at") },
    { label: lastInteractionType, at: lastInteractionType === "clicked" ? null : lastInteractionAt },
  ].filter((event) => event.at);
  return <ol className="admin-timeline" aria-label="Recommendation timeline">
    {events.map((event) => <li key={`${event.label}-${event.at}`}><span>{event.label.replaceAll("_", " ")}</span><time title={String(event.at)}>{compactDateTime(event.at)}</time></li>)}
  </ol>;
}

function LatestActivity({ item, loading }: { item: JsonRecord | null; loading: boolean }) {
  const eventType = text(item, "event_type", "action", "type").replaceAll("_", " ") || "No activity yet";
  const source = text(item, "source") || "System";
  const status = text(item, "result", "status") || "Recorded";
  const occurredAt = value(item, "created_at", "occurred_at", "timestamp", "started_at");
  return <article className="admin-latest-activity" aria-label="Latest activity">
    <span>Latest activity</span>
    <strong>{loading ? "Loading…" : eventType}</strong>
    {!loading && item && <p><time title={String(occurredAt || "")}>{compactDateTime(occurredAt)}</time><span aria-hidden="true"> · </span>{source}</p>}
    {!loading && item && <Status>{status}</Status>}
  </article>;
}

export function AdminDashboard() {
  const [tab, setTab] = useState<Tab>("channels");
  const [summary, setSummary] = useState<JsonRecord | null>(null);
  const [latestActivity, setLatestActivity] = useState<JsonRecord | null>(null);
  const [performance, setPerformance] = useState<JsonRecord[]>([]);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState("");
  const [list, setList] = useState<PageResult>(emptyPage);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const [matchLabHomepageVisible, setMatchLabHomepageVisible] = useState(true);
  const [savedMatchLabHomepageVisible, setSavedMatchLabHomepageVisible] = useState(true);
  const [featureFlagLoading, setFeatureFlagLoading] = useState(true);
  const [featureFlagSaving, setFeatureFlagSaving] = useState(false);
  const [featureFlagMessage, setFeatureFlagMessage] = useState("");
  const [featureFlagError, setFeatureFlagError] = useState("");
  const [detail, setDetail] = useState<DetailState>(null);
  const [page, setPage] = useState<Record<Tab, number>>({ channels: 1, videos: 1, recommendations: 1 });
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState<Record<Tab, string>>({ channels: "", videos: "", recommendations: "" });
  const [showInactive, setShowInactive] = useState(false);
  const [channelSort, setChannelSort] = useState("name:asc");
  const [videoSort, setVideoSort] = useState("published_at:desc");
  const [videoChannel, setVideoChannel] = useState("");
  const [videoEmbedding, setVideoEmbedding] = useState("");
  const [videoRecommended, setVideoRecommended] = useState("");
  const [videoPublishedAfter, setVideoPublishedAfter] = useState("");
  const [videoIngestedAfter, setVideoIngestedAfter] = useState("");
  const [recommendationSort, setRecommendationSort] = useState("created_at:desc");
  const [deliveryState, setDeliveryState] = useState("");
  const [rating, setRating] = useState("");
  const [videoSearchMode, setVideoSearchMode] = useState<"text" | "vector">("text");
  const [hiddenColumns, setHiddenColumns] = useState<Record<Tab, string[]>>({ channels: [], videos: [], recommendations: [] });
  const [vectorPhrase, setVectorPhrase] = useState("");
  const [channelUrl, setChannelUrl] = useState("");
  const [maxAge, setMaxAge] = useState(7);
  const [resolvedChannel, setResolvedChannel] = useState<JsonRecord | null>(null);
  const [resolveState, setResolveState] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const [resolveError, setResolveError] = useState("");
  const [mutationId, setMutationId] = useState("");
  const triggerRef = useRef<HTMLElement | null>(null);
  const modalCloseRef = useRef<HTMLButtonElement>(null);
  const latestResolve = useRef(0);
  const listGeneration = useRef(0);
  const listController = useRef<AbortController | null>(null);
  const pendingTrackingFocus = useRef<string | null>(null);
  const listKey = JSON.stringify([tab, page, search, channelSort, showInactive, videoSort, videoChannel, videoEmbedding, videoRecommended, videoPublishedAfter, videoIngestedAfter, recommendationSort, deliveryState, rating, videoSearchMode]);
  const activeListKey = useRef(listKey);

  useLayoutEffect(() => {
    activeListKey.current = listKey;
    listGeneration.current += 1;
    listController.current?.abort();
    return () => { listGeneration.current += 1; listController.current?.abort(); };
  }, [listKey]);

  useEffect(() => {
    if (!pendingTrackingFocus.current) return;
    if (tab !== "channels") { pendingTrackingFocus.current = null; return; }
    if (listLoading || mutationId) return;
    const action = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tracking-channel]"))
      .find((button) => button.dataset.trackingChannel === pendingTrackingFocus.current);
    action?.focus();
    pendingTrackingFocus.current = null;
  }, [listLoading, mutationId, tab]);

  const announce = useCallback((message: string, error = false) => {
    setNotice(message);
    setNoticeError(error);
  }, []);

  const changeTab = useCallback((nextTab: Tab) => {
    setTab(nextTab);
    setSearchDraft(search[nextTab]);
    setList(emptyPage);
    announce("");
  }, [announce, search]);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    setOverviewError("");
    try {
      const [nextSummary, activityPayload, performancePayload] = await Promise.all([
        adminRequest<JsonRecord>("summary"),
        adminRequest<unknown>("activity?limit=1"),
        adminRequest<unknown>("performance?days=30"),
      ]);
      setSummary(nextSummary);
      setLatestActivity(pageResult<JsonRecord>(activityPayload, 1, 1).items[0] || null);
      setPerformance(Array.isArray(performancePayload) ? performancePayload as JsonRecord[] : pageResult<JsonRecord>(performancePayload, 1, 30).items);
    } catch (error) {
      setOverviewError(requestMessage(error, "The operations summary is unavailable."));
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const loadFeatureFlag = useCallback(async () => {
    setFeatureFlagLoading(true);
    setFeatureFlagError("");
    try {
      const payload = await adminRequest<JsonRecord>("feature-flags/match-lab-homepage");
      const enabled = booleanValue(payload, "enabled");
      setMatchLabHomepageVisible(enabled);
      setSavedMatchLabHomepageVisible(enabled);
    } catch (error) {
      setFeatureFlagError(requestMessage(error, "Homepage visibility could not be loaded."));
    } finally {
      setFeatureFlagLoading(false);
    }
  }, []);

  const loadList = useCallback(async () => {
    // A mutation begun on another tab must not reload its old query afterward.
    if (activeListKey.current !== listKey) return;
    const generation = ++listGeneration.current;
    listController.current?.abort();
    setListError("");
    if (tab === "videos" && videoSearchMode === "vector") { setListLoading(false); return; }
    const controller = new AbortController();
    listController.current = controller;
    setListLoading(true);
    const params = new URLSearchParams({ page: String(page[tab]), page_size: String(pageSize) });
    if (search[tab]) params.set("search", search[tab]);
    if (tab === "channels") {
      const [sort, direction] = channelSort.split(":");
      params.set("sort", sort);
      params.set("direction", direction);
      if (showInactive) params.set("include_inactive", "true");
    }
    if (tab === "videos") {
      const [sort, direction] = videoSort.split(":");
      params.set("sort", sort);
      params.set("direction", direction);
      if (videoChannel) params.set("channel_id", videoChannel);
      if (videoEmbedding) params.set("embedding", videoEmbedding);
      if (videoRecommended) params.set("has_recommendations", videoRecommended);
      if (videoPublishedAfter) params.set("published_after", videoPublishedAfter);
      if (videoIngestedAfter) params.set("ingested_after", videoIngestedAfter);
    }
    if (tab === "recommendations") {
      const [sort, direction] = recommendationSort.split(":");
      params.set("sort", sort);
      params.set("direction", direction);
      if (deliveryState) params.set("delivery_state", deliveryState);
      if (rating) params.set("rating", rating);
    }
    try {
      const payload = await adminRequest<unknown>(`${tab}?${params}`, undefined, controller.signal);
      if (generation !== listGeneration.current || controller.signal.aborted) return;
      setList(pageResult<JsonRecord>(payload, page[tab], pageSize));
    } catch (error) {
      if (generation !== listGeneration.current || controller.signal.aborted) return;
      setListError(requestMessage(error, `The ${tab} list is unavailable.`));
    } finally {
      if (generation === listGeneration.current && !controller.signal.aborted) setListLoading(false);
    }
  }, [channelSort, deliveryState, listKey, page, rating, recommendationSort, search, showInactive, tab, videoChannel, videoEmbedding, videoIngestedAfter, videoPublishedAfter, videoRecommended, videoSearchMode, videoSort]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadOverview(), 0);
    return () => window.clearTimeout(task);
  }, [loadOverview]);
  useEffect(() => {
    const task = window.setTimeout(() => void loadFeatureFlag(), 0);
    return () => window.clearTimeout(task);
  }, [loadFeatureFlag]);
  useEffect(() => {
    const task = window.setTimeout(() => void loadList(), 0);
    return () => window.clearTimeout(task);
  }, [loadList]);

  useEffect(() => {
    const sequence = ++latestResolve.current;
    if (!channelUrl || !isChannelUrl(channelUrl)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const channel = await adminRequest<JsonRecord>("channels/resolve", { method: "POST", body: JSON.stringify({ url: channelUrl }) }, controller.signal);
        if (sequence !== latestResolve.current) return;
        setResolvedChannel(channel);
        setResolveState("ready");
      } catch (error) {
        if (sequence !== latestResolve.current || controller.signal.aborted) return;
        setResolveState("error");
        setResolveError(requestMessage(error, "That channel could not be resolved."));
      }
    }, 500);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [channelUrl]);

  const closeDetail = useCallback(() => {
    setDetail(null);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  async function openDetail(kind: Tab, item: JsonRecord, trigger: HTMLElement) {
    triggerRef.current = trigger;
    setDetail({ kind, item });
    const id = text(item, "id");
    if (!id || kind === "channels") return;
    try {
      const full = await adminRequest<JsonRecord>(`${kind}/${encodeURIComponent(id)}`);
      setDetail((current) => current && text(current.item, "id") === id ? { kind, item: full } : current);
    } catch (error) {
      if (!(error instanceof AdminApiError && error.status === 404)) announce(requestMessage(error, "Some record details could not be loaded."), true);
    }
  }

  async function refresh() {
    setRefreshing(true);
    announce("");
    await Promise.all([loadOverview(), loadList(), loadFeatureFlag()]);
    setRefreshing(false);
  }

  async function saveFeatureFlag(event: FormEvent) {
    event.preventDefault();
    setFeatureFlagSaving(true);
    setFeatureFlagError("");
    setFeatureFlagMessage("");
    try {
      const payload = await adminRequest<JsonRecord>("feature-flags/match-lab-homepage", {
        method: "PATCH",
        body: JSON.stringify({ enabled: matchLabHomepageVisible }),
      });
      const enabled = booleanValue(payload, "enabled");
      setMatchLabHomepageVisible(enabled);
      setSavedMatchLabHomepageVisible(enabled);
      setFeatureFlagMessage(enabled ? "Match Lab links are visible on the home page." : "Match Lab links are hidden from the home page.");
    } catch (error) {
      setFeatureFlagError(requestMessage(error, "Homepage visibility did not save."));
    } finally {
      setFeatureFlagSaving(false);
    }
  }

  function applySearch(event: FormEvent) {
    event.preventDefault();
    setPage((current) => ({ ...current, [tab]: 1 }));
    setSearch((current) => ({ ...current, [tab]: searchDraft.trim() }));
  }

  function clearFilters() {
    setSearchDraft("");
    setSearch((current) => ({ ...current, [tab]: "" }));
    setPage((current) => ({ ...current, [tab]: 1 }));
    if (tab === "channels") setShowInactive(false);
    if (tab === "videos") {
      setVideoSearchMode("text");
      setVectorPhrase("");
      setVideoChannel("");
      setVideoEmbedding("");
      setVideoRecommended("");
      setVideoPublishedAfter("");
      setVideoIngestedAfter("");
    }
    if (tab === "recommendations") {
      setDeliveryState("");
      setRating("");
    }
    announce(`${tab[0].toUpperCase()}${tab.slice(1)} filters cleared.`);
  }

  async function vectorSearch(event: FormEvent) {
    event.preventDefault();
    if (!vectorPhrase.trim()) return;
    const generation = ++listGeneration.current;
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setListLoading(true);
    setListError("");
    try {
      const payload = await adminRequest<unknown>("videos/vector-search", { method: "POST", body: JSON.stringify({ phrase: vectorPhrase.trim(), limit: 20 }) }, controller.signal);
      if (generation !== listGeneration.current || controller.signal.aborted) return;
      setList(pageResult<JsonRecord>(payload, 1, 20));
    } catch (error) {
      if (generation !== listGeneration.current || controller.signal.aborted) return;
      setListError(requestMessage(error, "Vector search is unavailable."));
    } finally {
      if (generation === listGeneration.current && !controller.signal.aborted) setListLoading(false);
    }
  }

  async function addChannel(event: FormEvent) {
    event.preventDefault();
    if (!resolvedChannel) return;
    setMutationId("add");
    announce("");
    try {
      const result = await adminRequest<JsonRecord>("channels", { method: "POST", body: JSON.stringify({ url: channelUrl, max_video_age_days: maxAge }) });
      announce(booleanValue(result, "reactivated") ? "Channel restored and tracking resumed." : "Channel added. Recent uploads will be checked first.");
      setChannelUrl("");
      setResolvedChannel(null);
      await Promise.all([loadList(), loadOverview()]);
    } catch (error) {
      announce(requestMessage(error, "The channel could not be added."), true);
    } finally {
      setMutationId("");
    }
  }

  async function patchChannel(item: JsonRecord, patch: JsonRecord) {
    const id = text(item, "id");
    if (!id) return;
    const restoring = patch.is_active === true;
    setMutationId(id);
    if ("is_active" in patch) {
      pendingTrackingFocus.current = id;
      setList((current) => ({ ...current, items: current.items.map((row) => text(row, "id") === id ? { ...row, ...patch } : row) }));
    }
    try {
      await adminRequest(`channels/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      announce("max_video_age_days" in patch ? "Maximum video age updated." : restoring ? "Tracking restored." : "Tracking paused. Existing history was preserved.");
      await Promise.all([loadList(), loadOverview()]);
    } catch (error) {
      const reason = requestMessage(error, "The channel update did not save.");
      announce(`${reason} The previous tracking state was restored.`, true);
      await loadList();
    } finally {
      setMutationId("");
    }
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "channels", label: "Channels" },
    { id: "videos", label: "Videos" },
    { id: "recommendations", label: "Recommendations" },
  ];
  function onChannelUrlChange(nextUrl: string) {
    setChannelUrl(nextUrl);
    setResolvedChannel(null);
    setResolveError("");
    if (!nextUrl) { setResolveState("idle"); return; }
    if (!isChannelUrl(nextUrl)) {
      setResolveState("error");
      setResolveError("Use a youtube.com/@handle or youtube.com/channel/… URL.");
      return;
    }
    setResolveState("loading");
  }

  const hasActiveFilters = Boolean(
    search[tab]
    || searchDraft.trim()
    || (tab === "channels" && showInactive)
    || (tab === "videos" && (videoSearchMode === "vector" || vectorPhrase.trim() || videoChannel || videoEmbedding || videoRecommended || videoPublishedAfter || videoIngestedAfter))
    || (tab === "recommendations" && (deliveryState || rating)),
  );
  const tabLabel = tabs.find((item) => item.id === tab)?.label || tab;

  return (
    <SignalShell active="admin" className="admin-shell">
      <main id="main" tabIndex={-1} className={`${styles.adminMain} admin-main`}>
        <header className="admin-header">
          <button className="admin-refresh" onClick={() => void refresh()} disabled={refreshing}><Icon name="refresh" />{refreshing ? "Refreshing…" : "Refresh"}</button>
        </header>

        {notice && <p className={`admin-notice ${noticeError ? "error" : ""}`} role={noticeError ? "alert" : "status"}>{notice}</p>}

        <section className="admin-records" aria-labelledby="records-heading">
          <div className="admin-tabs" role="tablist" aria-label="Operations records">
            {tabs.map((item, index) => <button key={item.id} id={`tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => changeTab(item.id)} onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const offset = event.key === "ArrowRight" ? 1 : -1; const next = tabs[(index + offset + tabs.length) % tabs.length].id; changeTab(next); window.setTimeout(() => document.getElementById(`tab-${next}`)?.focus(), 0); }}>{item.label}</button>)}
          </div>

          <div className="admin-tab-panel" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          <div className="admin-records-heading"><h2 id="records-heading">{tabLabel}</h2><span>{listLoading ? "Loading" : `${list.total.toLocaleString()} records`}</span></div>

            <div className="admin-controls" key={tab}>
              {tab === "videos" && <label className="admin-control compact-control"><span>Search mode</span><select value={videoSearchMode} onChange={(event) => { setVideoSearchMode(event.target.value as "text" | "vector"); setList(emptyPage); }}>{/* options are intentionally explicit */}<option value="text">Text</option><option value="vector">Meaning</option></select></label>}
              <form className="admin-search" onSubmit={videoSearchMode === "vector" && tab === "videos" ? vectorSearch : applySearch}>
                <Icon name="search" /><label className="sr-only" htmlFor="admin-search">Search {tab}</label><input id="admin-search" value={tab === "videos" && videoSearchMode === "vector" ? vectorPhrase : searchDraft} onChange={(event) => tab === "videos" && videoSearchMode === "vector" ? setVectorPhrase(event.target.value) : setSearchDraft(event.target.value)} placeholder={tab === "videos" && videoSearchMode === "vector" ? "Describe an idea to retrieve" : `Search ${tab}`} /><button>{tab === "videos" && videoSearchMode === "vector" ? "Search meaning" : "Search"}</button>
              </form>
              {tab === "channels" && <><label className="admin-control"><span>Sort</span><select value={channelSort} onChange={(event) => setChannelSort(event.target.value)}><option value="name:asc">Name</option><option value="last_sync_started_at:desc">Last sync</option><option value="created_at:desc">Recently added</option><option value="latest_video_published_at:desc">Latest video</option></select></label><label className="admin-check"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /><span>Show inactive</span></label></>}
              {tab === "videos" && videoSearchMode === "text" && <VideoFilters values={{ videoSort, videoChannel, videoEmbedding, videoRecommended, videoPublishedAfter, videoIngestedAfter }} setters={{ setVideoSort, setVideoChannel, setVideoEmbedding, setVideoRecommended, setVideoPublishedAfter, setVideoIngestedAfter }} channels={summary} />}
              {tab === "recommendations" && <><label className="admin-control"><span>State</span><select value={deliveryState} onChange={(event) => setDeliveryState(event.target.value)}><option value="">All</option><option value="queued">Queued</option><option value="delivered">Delivered</option></select></label><label className="admin-control"><span>Rating</span><select value={rating} onChange={(event) => setRating(event.target.value)}><option value="">All</option><option value="up">Up</option><option value="down">Down</option><option value="unrated">Unrated</option></select></label><label className="admin-control admin-sort-control"><span>Sort</span><select value={recommendationSort} onChange={(event) => setRecommendationSort(event.target.value)}><option value="created_at:desc">Newest</option><option value="created_at:asc">Oldest</option><option value="delivered_at:desc">Delivery time</option><option value="clicked_at:desc">Click time</option><option value="rating:asc">Rating</option></select></label></>}
              <ColumnChooser tab={tab} hidden={hiddenColumns[tab]} setHidden={(next) => setHiddenColumns((current) => ({ ...current, [tab]: next }))} />
              {hasActiveFilters && <button className="admin-clear-filters" type="button" onClick={clearFilters}>Clear filters</button>}
            </div>

            {tab === "channels" && <details className="admin-add-channel"><summary>Add a tracked channel <span>Resolve a YouTube URL before saving</span></summary><ChannelResolver url={channelUrl} setUrl={onChannelUrlChange} maxAge={maxAge} setMaxAge={setMaxAge} state={resolveState} error={resolveError} resolved={resolvedChannel} submit={addChannel} busy={mutationId === "add"} /></details>}

            <p className="sr-only" role="status" aria-live="polite">{listLoading ? `Loading ${tab}.` : !listError ? `${list.total} ${tab} loaded.` : ""}</p>
            {listError ? <ErrorState message={listError} retry={() => void loadList()} /> : listLoading || list.items.length ? <RecordTable tab={tab} data={list} loading={listLoading} mutationId={mutationId} open={openDetail} patchChannel={patchChannel} hiddenColumns={hiddenColumns[tab]} /> : <EmptyState title={tab === "videos" && videoSearchMode === "vector" && !vectorPhrase ? "Search by meaning" : hasActiveFilters ? `No matching ${tab}` : `No ${tab} yet`} message={tab === "videos" && videoSearchMode === "vector" ? "Enter a phrase to rank compatible stored vectors." : hasActiveFilters ? "Clear filters to return to the full record set." : "Refresh after the next worker run."} />}
            {!listError && !!list.items.length && <Pagination data={list} go={(next) => setPage((current) => ({ ...current, [tab]: next }))} />}
          </div>
        </section>

        <section className="admin-feature" aria-labelledby="feature-heading">
          <div className="admin-section-heading"><h2 id="feature-heading">Feature visibility</h2></div>
          <form className="admin-feature-setting" onSubmit={saveFeatureFlag} aria-busy={featureFlagLoading || featureFlagSaving}>
            <div><h3>Match Lab on the home page</h3><p>Hide the public links while keeping the Match Lab available at its direct URL.</p></div>
            <label className="admin-check"><input type="checkbox" checked={matchLabHomepageVisible} disabled={featureFlagLoading || featureFlagSaving || Boolean(featureFlagError)} onChange={(event) => { setMatchLabHomepageVisible(event.target.checked); setFeatureFlagMessage(""); }} /><span>Show Match Lab links</span></label>
            <button className="admin-primary" disabled={featureFlagLoading || featureFlagSaving || Boolean(featureFlagError) || matchLabHomepageVisible === savedMatchLabHomepageVisible}>{featureFlagSaving ? "Saving…" : "Save"}</button>
          </form>
          <p className={`admin-feature-feedback ${featureFlagError ? "error-text" : ""}`} aria-live="polite">{featureFlagLoading ? "Loading homepage visibility…" : featureFlagError || featureFlagMessage}</p>
          {featureFlagError && <button className="admin-text-button" onClick={() => void loadFeatureFlag()}>Try again</button>}
        </section>

        <section className="admin-overview" aria-labelledby="health-heading">
          <div className="admin-section-heading"><h2 id="health-heading">System health</h2></div>
          {overviewError ? <ErrorState message={overviewError} retry={() => void loadOverview()} /> : (
            <div className="admin-summary-strip" aria-busy={overviewLoading}>
              {[
                ["Active channels", "active_channel_count", "active_channels"],
                ["Videos", "videos", "video_count", "total_videos"],
                ["Recommendations", "recommendations", "recommendation_count", "total_recommendations"],
                ["Queued", "queued_recommendation_count", "queued_recommendations"],
                ["Delivered", "delivered_recommendation_count", "delivered_recommendations"],
              ].map(([label, ...keys]) => <div key={label}><span>{label}</span><strong>{overviewLoading ? "—" : compactNumber(value(summary, ...keys))}</strong></div>)}
              <LatestActivity item={latestActivity} loading={overviewLoading} />
            </div>
          )}
          {!overviewLoading && !overviewError && <p className="admin-worker-status">Worker: {text(summary, "worker_status") || "awaiting heartbeat"}{text(summary, "worker_last_seen_at") ? ` · Last seen ${new Date(text(summary, "worker_last_seen_at")).toLocaleString()}` : ""}{text(summary, "worker_error") ? ` · ${text(summary, "worker_error")}` : ""}{Array.isArray(summary?.provider_usage) && summary.provider_usage.length > 0 ? ` · Requests today (UTC): ${(summary.provider_usage as JsonRecord[]).map((item) => `${text(item, "provider")} ${value(item, "requests")}`).join(", ")}` : ""}</p>}
        </section>

        <section className="admin-performance" aria-labelledby="performance-heading">
          <h2 className="sr-only" id="performance-heading">Performance</h2>
          <details><summary>Performance <span>{performance.length ? "Daily feedback and useful share" : "No feedback data yet"}</span></summary>{!overviewError && <PerformanceChart data={performance} />}</details>
        </section>
      </main>
      <RecordModal state={detail} close={closeDetail} closeRef={modalCloseRef} />
    </SignalShell>
  );
}

function ChannelResolver({ url, setUrl, maxAge, setMaxAge, state, error, resolved, submit, busy }: { url: string; setUrl: (value: string) => void; maxAge: number; setMaxAge: (value: number) => void; state: string; error: string; resolved: JsonRecord | null; submit: (event: FormEvent) => void; busy: boolean }) {
  const existing = booleanValue(resolved, "already_tracked", "exists");
  const active = booleanValue(resolved, "is_active", "active");
  return <form className="admin-resolver" onSubmit={submit}>
    <div className="admin-resolver-fields"><label><span>YouTube channel URL</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://youtube.com/@handle" required aria-describedby="resolver-help" /></label><label><span>Video window</span><NumberStepper label="New channel video window" value={maxAge} setValue={setMaxAge} min={1} max={365} unit="days" /></label></div>
    <p id="resolver-help" className={`admin-resolver-help ${state === "error" ? "error" : ""}`} role={state === "error" ? "alert" : undefined}>{state === "loading" ? "Resolving channel…" : error || "Paste a channel, handle, video, or youtu.be URL."}</p>
    {resolved && <div className="admin-resolved">
      {text(resolved, "thumbnail_url", "thumbnail") ? <img src={text(resolved, "thumbnail_url", "thumbnail")} alt="" /> : <span className="admin-thumbnail-fallback">{text(resolved, "name", "title").slice(0, 1)}</span>}
      <div><strong>{text(resolved, "name", "title") || "Resolved channel"}</strong><p>{text(resolved, "description") || "No public description supplied."}</p><small>{compactNumber(value(resolved, "subscriber_count"))} subscribers · {compactNumber(value(resolved, "public_video_count", "video_count"))} public videos</small></div>
      <button className="admin-primary" disabled={busy || (existing && active)}>{busy ? "Saving…" : existing && !active ? "Reactivate" : existing ? "Already active" : "Add channel"}<Icon name="arrow" /></button>
    </div>}
  </form>;
}

function VideoFilters({ values, setters, channels }: { values: Record<string, string>; setters: Record<string, (value: string) => void>; channels: JsonRecord | null }) {
  const channelOptions = value(channels, "channel_options", "channels");
  return <details className="admin-filter-drawer"><summary>More filters</summary><div>
    <label className="admin-control"><span>Channel</span><select value={values.videoChannel} onChange={(event) => setters.setVideoChannel(event.target.value)}><option value="">All</option>{Array.isArray(channelOptions) && channelOptions.map((item) => { const record = item as JsonRecord; return <option key={text(record, "id")} value={text(record, "id")}>{text(record, "name")}</option>; })}</select></label>
    <label className="admin-control"><span>Embedding</span><select value={values.videoEmbedding} onChange={(event) => setters.setVideoEmbedding(event.target.value)}><option value="">Any</option><option value="present">Present</option><option value="missing">Missing</option></select></label>
    <label className="admin-control"><span>Recommendation</span><select value={values.videoRecommended} onChange={(event) => setters.setVideoRecommended(event.target.value)}><option value="">Any</option><option value="true">Has recommendations</option><option value="false">None</option></select></label>
    <label className="admin-control"><span>Published after</span><input type="date" value={values.videoPublishedAfter} onChange={(event) => setters.setVideoPublishedAfter(event.target.value)} /></label>
    <label className="admin-control"><span>Ingested after</span><input type="date" value={values.videoIngestedAfter} onChange={(event) => setters.setVideoIngestedAfter(event.target.value)} /></label>
    <label className="admin-control"><span>Sort</span><select value={values.videoSort} onChange={(event) => setters.setVideoSort(event.target.value)}><option value="published_at:desc">Recently published</option><option value="ingested_at:desc">Recently ingested</option><option value="view_count:desc">Most viewed</option><option value="title:asc">Title</option></select></label>
  </div></details>;
}

function ColumnChooser({ tab, hidden, setHidden }: { tab: Tab; hidden: string[]; setHidden: (columns: string[]) => void }) {
  const options: Record<Tab, Array<{ id: string; label: string }>> = {
    channels: [{ id: "channel-videos", label: "Videos" }],
    videos: [
      { id: "video-ingested", label: "Ingested" },
      { id: "video-duration", label: "Duration" },
      { id: "video-views", label: "Views" },
    ],
    recommendations: [
      { id: "recommendation-rationale", label: "Rationale" },
      { id: "recommendation-timeline", label: "Timeline" },
    ],
  };
  return <details className="admin-column-chooser">
    <summary>Choose columns</summary>
    <div>{options[tab].map((option) => <label key={option.id}><input type="checkbox" checked={!hidden.includes(option.id)} onChange={(event) => setHidden(event.target.checked ? hidden.filter((item) => item !== option.id) : [...hidden, option.id])} /><span>{option.label}</span></label>)}</div>
  </details>;
}
function RecordTable({ tab, data, loading, mutationId, open, patchChannel, hiddenColumns }: { tab: Tab; data: PageResult; loading: boolean; mutationId: string; open: (kind: Tab, item: JsonRecord, trigger: HTMLElement) => void; patchChannel: (item: JsonRecord, patch: JsonRecord) => void; hiddenColumns: string[] }) {
  const columns = tab === "channels" ? 6 : tab === "videos" ? 8 : 7;
  return <div className="admin-table-wrap" tabIndex={0} aria-label={tab + " records"}><table className={["admin-table", tab, ...hiddenColumns.map((column) => "hide-" + column)].join(" ")}><thead><tr>
    {tab === "channels" && <><th>Channel</th><th>Tracking</th><th>Video window</th><th className="optional-column col-channel-videos">Videos</th><th>Last sync</th><th><span className="sr-only">Actions</span></th></>}
    {tab === "videos" && <><th>Video</th><th>Channel</th><th>Published</th><th className="optional-column col-video-ingested">Ingested</th><th className="optional-column col-video-duration">Duration</th><th className="optional-column col-video-views">Views</th><th>Embedding</th><th><span className="sr-only">Actions</span></th></>}
    {tab === "recommendations" && <><th>Recipient</th><th>Video</th><th className="optional-column col-recommendation-rationale">Rationale</th><th>Delivery</th><th>Rating</th><th className="optional-column col-recommendation-timeline">Timeline</th><th><span className="sr-only">Actions</span></th></>}
  </tr></thead><tbody>{loading ? <LoadingRows columns={columns} /> : data.items.map((item) => <RecordRow key={text(item, "id")} tab={tab} item={item} busy={mutationId === text(item, "id")} open={open} patchChannel={patchChannel} />)}</tbody></table></div>;
}

function RecordRow({ tab, item, busy, open, patchChannel }: { tab: Tab; item: JsonRecord; busy: boolean; open: (kind: Tab, item: JsonRecord, trigger: HTMLElement) => void; patchChannel: (item: JsonRecord, patch: JsonRecord) => void }) {
  const active = value(item, "is_active", "active") !== false;
  const [confirmingPause, setConfirmingPause] = useState(false);
  const cancelPauseRef = useRef<HTMLButtonElement>(null);
  const trackingRef = useRef<HTMLButtonElement>(null);
  const cancelledPause = useRef(false);
  useEffect(() => {
    if (confirmingPause) cancelPauseRef.current?.focus();
    else if (cancelledPause.current) {
      trackingRef.current?.focus();
      cancelledPause.current = false;
    }
  }, [confirmingPause]);
  const channelName = text(item, "name") || "this channel";
  if (tab === "channels") return <tr className={!active ? "inactive-row" : ""}>
    <td className="channel-primary"><div className="admin-record-title">{text(item, "thumbnail_url", "thumbnail") ? <img src={text(item, "thumbnail_url", "thumbnail")} alt="" /> : <span>{text(item, "name").slice(0, 1)}</span>}<div><strong>{text(item, "name")}</strong><a href={text(item, "url", "canonical_url")} target="_blank" rel="noreferrer">Open YouTube</a></div></div></td>
    <td className="channel-status"><Status>{active ? "Active" : "Paused"}</Status></td>
    <td className="channel-window"><ChannelAgeControl key={`${text(item, "id")}:${numberValue(item, "max_video_age_days")}`} item={item} save={patchChannel} /></td>
    <td className="channel-videos optional-column col-channel-videos">{numberValue(item, "ingested_video_count", "video_count").toLocaleString()}</td><td className="channel-sync admin-last-sync"><time title={text(item, "last_sync_completed_at", "last_ingestion_at")}>{compactDateTime(value(item, "last_sync_completed_at", "last_ingestion_at"), "Not recorded")}</time>{text(item, "sync_error", "last_sync_error") && <small className="error-text">Sync issue</small>}</td>
    <td className="channel-actions admin-row-actions">{confirmingPause && active ? <div className="admin-pause-confirmation" role="group" aria-label={`Pause tracking for ${channelName}`}><span>Pause tracking for <strong>{channelName}</strong>?</span><button className="admin-text-button stop" disabled={busy} onClick={() => { setConfirmingPause(false); void patchChannel(item, { is_active: false }); }}>Pause</button><button ref={cancelPauseRef} className="admin-text-button" disabled={busy} onClick={() => { cancelledPause.current = true; setConfirmingPause(false); }}>Cancel</button></div> : <button ref={trackingRef} data-tracking-channel={text(item, "id")} className={`admin-text-button ${active ? "stop" : "restore"}`} disabled={busy} onClick={() => active ? setConfirmingPause(true) : void patchChannel(item, { is_active: true })}>{busy ? "Saving…" : active ? "Pause tracking" : "Restore tracking"}</button>}<button className="admin-details-button" onClick={(event) => void open(tab, item, event.currentTarget)}>Details</button></td>
  </tr>;
  if (tab === "videos") return <tr>
    <td className="video-primary"><div className="admin-record-title">{text(item, "thumbnail_url", "thumbnail") ? <img src={text(item, "thumbnail_url", "thumbnail")} alt="" /> : <span /> }<div><strong>{text(item, "title")}</strong><a href={text(item, "youtube_url", "url")} target="_blank" rel="noreferrer">Watch video</a></div></div></td><td className="video-channel">{text(item, "channel_name")}</td><td className="video-published"><time title={text(item, "published_at")}>{localTime(value(item, "published_at"), "—")}</time></td><td className="video-ingested optional-column col-video-ingested"><time title={text(item, "created_at", "ingested_at")}>{localTime(value(item, "ingested_at", "created_at"), "—")}</time></td><td className="video-duration optional-column col-video-duration">{duration(value(item, "duration_seconds"))}</td><td className="video-views optional-column col-video-views">{compactNumber(value(item, "view_count", "views"))}</td><td className="video-index">{value(item, "similarity") !== null && <strong>{numberValue(item, "similarity").toFixed(3) + " semantic similarity"}</strong>}<Status>{booleanValue(item, "has_embedding") || Boolean(value(item, "embedding_model")) ? text(item, "embedding_model") || "Embedded" : "Missing"}</Status><small>{numberValue(item, "recommendation_count")} recommendations</small></td><td className="video-actions"><button className="admin-details-button" onClick={(event) => void open(tab, item, event.currentTarget)}>Details</button></td>
  </tr>;
  const delivered = Boolean(value(item, "delivered_at"));
  const videoDetails = [
    text(item, "channel_name"),
    compactDateTime(value(item, "video_published_at"), ""),
    duration(value(item, "video_duration_seconds")),
    `${compactNumber(value(item, "video_view_count"))} views`,
  ].filter((detail) => detail && detail !== "—");
  return <tr><td className="recommendation-recipient"><strong>{text(item, "recipient_name", "user_display_name", "display_name") || "Recipient"}</strong><small>{text(item, "telegram_user_id", "telegram_id")}</small></td><td className="recommendation-video"><div className="admin-record-title admin-recommendation-video">{text(item, "thumbnail_url") ? <img src={text(item, "thumbnail_url")} alt="" /> : <span /> }<div><strong>{text(item, "video_title", "title")}</strong><a href={text(item, "youtube_url")} target="_blank" rel="noreferrer">Watch video</a><small>{videoDetails.join(" · ")}</small></div></div></td><td className="recommendation-rationale optional-column col-recommendation-rationale"><details className="admin-rationale"><summary>Why this matched</summary><p>{text(item, "rationale") || "No rationale recorded."}</p></details></td><td className="recommendation-delivery"><Status>{delivered ? "Delivered" : "Queued"}</Status></td><td className="recommendation-rating"><Status>{text(item, "rating") || "Unrated"}</Status></td><td className="recommendation-timeline optional-column col-recommendation-timeline"><RecommendationTimeline item={item} /></td><td className="recommendation-actions"><button className="admin-details-button" onClick={(event) => void open(tab, item, event.currentTarget)}>Details</button></td></tr>;
}
