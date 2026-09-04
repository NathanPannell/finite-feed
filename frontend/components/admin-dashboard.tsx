/* eslint-disable @next/next/no-img-element -- YouTube thumbnails come from runtime API records. */
"use client";

import {
  FormEvent,
  ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { SignalShell } from "@/components/signal-shell";
import { AdminApiError, adminRequest, JsonRecord, pageResult, PageResult } from "@/lib/admin-api";

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

function Icon({ name }: { name: "refresh" | "close" | "arrow" | "search" }) {
  const paths = {
    refresh: <><path d="M20 11a8 8 0 1 0-2.34 5.66" /><path d="M20 4v7h-7" /></>,
    close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
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

function DetailsValue({ data }: { data: unknown }) {
  if (data === null || data === undefined || data === "") return <span className="admin-null">Not recorded</span>;
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
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'));
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
  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section ref={dialogRef} className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="record-title">
        <header>
          <div><p>{state.kind.slice(0, -1)} record</p><h2 id="record-title">{text(state.item, "name", "title", "event_type", "id") || "Record details"}</h2></div>
          <button ref={closeRef} className="admin-icon-button" onClick={close} aria-label="Close details"><Icon name="close" /></button>
        </header>
        <div className="admin-detail-list">
          {Object.entries(state.item).map(([key, data]) => (
            <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd><DetailsValue data={data} /></dd></div>
          ))}
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
    <label className="admin-inline-number"><span className="sr-only">Maximum video age for {text(item, "name")}</span><input type="number" min="1" max="365" value={age} onChange={(event) => setAge(Math.min(365, Math.max(1, Number(event.target.value))))} /><i>days</i></label>
    {age !== initial && <button>Save</button>}
  </form>;
}

export function AdminDashboard() {
  const [tab, setTab] = useState<Tab>("channels");
  const [summary, setSummary] = useState<JsonRecord | null>(null);
  const [ownerOptions, setOwnerOptions] = useState<JsonRecord[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [activity, setActivity] = useState<JsonRecord[]>([]);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState("");
  const [list, setList] = useState<PageResult>(emptyPage);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
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

  const changeTab = useCallback((nextTab: Tab) => {
    setTab(nextTab);
    setSearchDraft(search[nextTab]);
    setList(emptyPage);
  }, [search]);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    setOverviewError("");
    try {
      const [nextSummary, activityPayload] = await Promise.all([
        adminRequest<JsonRecord>("summary"),
        adminRequest<unknown>("activity?limit=12"),
      ]);
      setSummary(nextSummary);
      const nextOwners = Array.isArray(nextSummary.owner_options)
        ? nextSummary.owner_options as JsonRecord[]
        : [];
      setOwnerOptions(nextOwners);
      setOwnerId((current) => {
        if (nextOwners.length === 1) return text(nextOwners[0], "id");
        return nextOwners.some((owner) => text(owner, "id") === current) ? current : "";
      });
      setActivity(pageResult<JsonRecord>(activityPayload, 1, 12).items);
    } catch (error) {
      setOverviewError(requestMessage(error, "The operations summary is unavailable."));
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const loadList = useCallback(async () => {
    if (tab === "videos" && videoSearchMode === "vector") return;
    setListLoading(true);
    setListError("");
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
      const payload = await adminRequest<unknown>(`${tab}?${params}`);
      setList(pageResult<JsonRecord>(payload, page[tab], pageSize));
    } catch (error) {
      setListError(requestMessage(error, `The ${tab} list is unavailable.`));
    } finally {
      setListLoading(false);
    }
  }, [channelSort, deliveryState, page, rating, recommendationSort, search, showInactive, tab, videoChannel, videoEmbedding, videoIngestedAfter, videoPublishedAfter, videoRecommended, videoSearchMode, videoSort]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadOverview(), 0);
    return () => window.clearTimeout(task);
  }, [loadOverview]);
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
      if (!(error instanceof AdminApiError && error.status === 404)) setNotice(requestMessage(error, "Some record details could not be loaded."));
    }
  }

  async function refresh() {
    setRefreshing(true);
    setNotice("");
    await Promise.all([loadOverview(), loadList()]);
    setRefreshing(false);
  }

  function applySearch(event: FormEvent) {
    event.preventDefault();
    setPage((current) => ({ ...current, [tab]: 1 }));
    setSearch((current) => ({ ...current, [tab]: searchDraft.trim() }));
  }

  async function vectorSearch(event: FormEvent) {
    event.preventDefault();
    if (!vectorPhrase.trim()) return;
    setListLoading(true);
    setListError("");
    try {
      const payload = await adminRequest<unknown>("videos/vector-search", { method: "POST", body: JSON.stringify({ phrase: vectorPhrase.trim(), limit: 20 }) });
      setList(pageResult<JsonRecord>(payload, 1, 20));
    } catch (error) {
      setListError(requestMessage(error, "Vector search is unavailable."));
    } finally {
      setListLoading(false);
    }
  }

  async function addChannel(event: FormEvent) {
    event.preventDefault();
    if (!resolvedChannel) return;
    if (ownerOptions.length > 1 && !ownerId) {
      setNotice("Select the channel owner before adding it.");
      return;
    }
    setMutationId("add");
    setNotice("");
    try {
      const result = await adminRequest<JsonRecord>("channels", { method: "POST", body: JSON.stringify({ url: channelUrl, max_video_age_days: maxAge, ...(ownerId ? { user_id: ownerId } : {}) }) });
      setNotice(booleanValue(result, "reactivated") ? "Channel restored and tracking resumed." : "Channel added. Recent uploads will be checked first.");
      setChannelUrl("");
      setResolvedChannel(null);
      await Promise.all([loadList(), loadOverview()]);
    } catch (error) {
      setNotice(requestMessage(error, "The channel could not be added."));
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
      setList((current) => ({ ...current, items: current.items.map((row) => text(row, "id") === id ? { ...row, ...patch } : row) }));
    }
    try {
      await adminRequest(`channels/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      setNotice("max_video_age_days" in patch ? "Maximum video age updated." : restoring ? "Tracking restored." : "Tracking stopped. Existing history was preserved.");
      await Promise.all([loadList(), loadOverview()]);
    } catch (error) {
      setNotice(requestMessage(error, "The channel update did not save."));
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
  const latestStatus = text(summary, "latest_ingestion_status", "ingestion_status") || "Waiting";
  const latestError = text(summary, "latest_ingestion_error", "ingestion_error");

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

  return (
    <SignalShell active="admin" className="admin-shell">

      <main className="admin-main">
        <header className="admin-header">
          <div><h1>Control room</h1><p>Inspect the pipeline, find records, and make narrow audited changes.</p></div>
          <button className="admin-refresh" onClick={() => void refresh()} disabled={refreshing}><Icon name="refresh" />{refreshing ? "Refreshing…" : "Refresh"}</button>
        </header>

        {notice && <p className="admin-notice" role="status">{notice}</p>}

        <section className="admin-overview" aria-labelledby="health-heading">
          <div className="admin-section-heading"><div><h2 id="health-heading">System health</h2><p>Current database and queue totals</p></div><time title={text(summary, "latest_ingestion_at", "latest_ingestion_time")}>Last sync {localTime(value(summary, "latest_ingestion_at", "latest_ingestion_time"), "not recorded")}</time></div>
          {overviewError ? <ErrorState message={overviewError} retry={() => void loadOverview()} /> : (
            <div className="admin-summary-strip" aria-busy={overviewLoading}>
              {[
                ["Active channels", "active_channel_count", "active_channels"],
                ["Videos", "videos", "video_count", "total_videos"],
                ["Recommendations", "recommendations", "recommendation_count", "total_recommendations"],
                ["Queued", "queued_recommendation_count", "queued_recommendations"],
                ["Delivered", "delivered_recommendation_count", "delivered_recommendations"],
              ].map(([label, ...keys]) => <div key={label}><span>{label}</span><strong>{overviewLoading ? "—" : compactNumber(value(summary, ...keys))}</strong></div>)}
              <div className="admin-ingestion-summary"><span>Latest ingestion</span><Status>{overviewLoading ? "Loading" : latestStatus}</Status>{latestError && <small title={latestError}>Error recorded</small>}</div>
            </div>
          )}
        </section>

        <section className="admin-activity" aria-labelledby="activity-heading">
          <div className="admin-section-heading"><div><h2 id="activity-heading">Recent activity</h2><p>Ingestion, user signals, and administrator changes</p></div></div>
          {!overviewError && !overviewLoading && !activity.length ? <EmptyState title="No activity yet" message="Worker runs and channel changes will appear here." /> : (
            <div className="admin-activity-list" aria-busy={overviewLoading}>
              {overviewLoading ? [0, 1, 2].map((item) => <div className="admin-activity-skeleton" key={item} />) : activity.map((item, index) => {
                const status = text(item, "status", "result") || "Recorded";
                const error = text(item, "error", "error_message");
                return <article key={text(item, "id", "target_id") || index}><span className={`admin-activity-mark ${statusTone(status)}`} aria-hidden="true" /><div><strong>{text(item, "event_type", "action", "type") || "Activity"}</strong><p>{text(item, "target", "affected_record", "description", "channel_name", "target_id") || "System record"}</p>{error && <small>{error}</small>}</div><div><Status>{status}</Status><time title={text(item, "occurred_at", "created_at", "timestamp", "started_at")}>{localTime(value(item, "occurred_at", "created_at", "timestamp", "started_at"))}</time></div></article>;
              })}
            </div>
          )}
        </section>

        <section className="admin-records" aria-labelledby="records-heading">
          <div className="admin-tabs" role="tablist" aria-label="Operations records">
            {tabs.map((item, index) => <button key={item.id} id={`tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => changeTab(item.id)} onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const offset = event.key === "ArrowRight" ? 1 : -1; const next = tabs[(index + offset + tabs.length) % tabs.length].id; changeTab(next); window.setTimeout(() => document.getElementById(`tab-${next}`)?.focus(), 0); }}>{item.label}</button>)}
          </div>

          <div className="admin-tab-panel" id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
            <div className="admin-records-heading"><div><h2 id="records-heading">{tabs.find((item) => item.id === tab)?.label}</h2><p>{tab === "channels" ? "Tracking state, age windows, and sync progress" : tab === "videos" ? "Immutable ingestion records and retrieval vectors" : "Immutable queue, delivery, and feedback records"}</p></div><span>{list.total.toLocaleString()} records</span></div>

            {tab === "channels" && <ChannelResolver url={channelUrl} setUrl={onChannelUrlChange} maxAge={maxAge} setMaxAge={setMaxAge} ownerOptions={ownerOptions} ownerId={ownerId} setOwnerId={setOwnerId} state={resolveState} error={resolveError} resolved={resolvedChannel} submit={addChannel} busy={mutationId === "add"} />}

            <div className="admin-controls">
              {tab === "videos" && <label className="admin-control compact-control"><span>Search mode</span><select value={videoSearchMode} onChange={(event) => { setVideoSearchMode(event.target.value as "text" | "vector"); setList(emptyPage); }}>{/* options are intentionally explicit */}<option value="text">Text</option><option value="vector">Meaning</option></select></label>}
              <form className="admin-search" onSubmit={videoSearchMode === "vector" && tab === "videos" ? vectorSearch : applySearch}>
                <Icon name="search" /><label className="sr-only" htmlFor="admin-search">Search {tab}</label><input id="admin-search" value={tab === "videos" && videoSearchMode === "vector" ? vectorPhrase : searchDraft} onChange={(event) => tab === "videos" && videoSearchMode === "vector" ? setVectorPhrase(event.target.value) : setSearchDraft(event.target.value)} placeholder={tab === "videos" && videoSearchMode === "vector" ? "Describe an idea to retrieve" : `Search ${tab}`} /><button>{tab === "videos" && videoSearchMode === "vector" ? "Search meaning" : "Search"}</button>
              </form>
              {tab === "channels" && <><label className="admin-control"><span>Sort</span><select value={channelSort} onChange={(event) => setChannelSort(event.target.value)}><option value="name:asc">Name</option><option value="last_sync_started_at:desc">Last sync</option><option value="created_at:desc">Recently added</option><option value="latest_video_published_at:desc">Latest video</option></select></label><label className="admin-check"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /><span>Show inactive</span></label></>}
              {tab === "videos" && videoSearchMode === "text" && <VideoFilters values={{ videoSort, videoChannel, videoEmbedding, videoRecommended, videoPublishedAfter, videoIngestedAfter }} setters={{ setVideoSort, setVideoChannel, setVideoEmbedding, setVideoRecommended, setVideoPublishedAfter, setVideoIngestedAfter }} channels={summary} />}
              <ColumnChooser tab={tab} hidden={hiddenColumns[tab]} setHidden={(next) => setHiddenColumns((current) => ({ ...current, [tab]: next }))} />
              {tab === "recommendations" && <><label className="admin-control"><span>State</span><select value={deliveryState} onChange={(event) => setDeliveryState(event.target.value)}><option value="">All</option><option value="queued">Queued</option><option value="delivered">Delivered</option></select></label><label className="admin-control"><span>Rating</span><select value={rating} onChange={(event) => setRating(event.target.value)}><option value="">All</option><option value="up">Up</option><option value="down">Down</option><option value="unrated">Unrated</option></select></label><label className="admin-control"><span>Sort</span><select value={recommendationSort} onChange={(event) => setRecommendationSort(event.target.value)}><option value="created_at:desc">Newest</option><option value="created_at:asc">Oldest</option><option value="delivered_at:desc">Delivery time</option><option value="clicked_at:desc">Click time</option><option value="rating:asc">Rating</option></select></label></>}
            </div>

            {listError ? <ErrorState message={listError} retry={() => void loadList()} /> : <RecordTable tab={tab} data={list} loading={listLoading} mutationId={mutationId} open={openDetail} patchChannel={patchChannel} hiddenColumns={hiddenColumns[tab]} />}
            {!listError && !listLoading && !list.items.length && <EmptyState title={tab === "videos" && videoSearchMode === "vector" && !vectorPhrase ? "Search by meaning" : `No ${tab} found`} message={tab === "videos" && videoSearchMode === "vector" ? "Enter a phrase to rank compatible stored vectors." : "Adjust the filters or refresh after the next worker run."} />}
            {!listError && !!list.items.length && <Pagination data={list} go={(next) => setPage((current) => ({ ...current, [tab]: next }))} />}
          </div>
        </section>
      </main>
      <RecordModal state={detail} close={closeDetail} closeRef={modalCloseRef} />
    </SignalShell>
  );
}

function ChannelResolver({ url, setUrl, maxAge, setMaxAge, ownerOptions, ownerId, setOwnerId, state, error, resolved, submit, busy }: { url: string; setUrl: (value: string) => void; maxAge: number; setMaxAge: (value: number) => void; ownerOptions: JsonRecord[]; ownerId: string; setOwnerId: (value: string) => void; state: string; error: string; resolved: JsonRecord | null; submit: (event: FormEvent) => void; busy: boolean }) {
  const existing = booleanValue(resolved, "already_tracked", "exists");
  const active = booleanValue(resolved, "is_active", "active");
  return <form className="admin-resolver" onSubmit={submit}>
    <div className="admin-resolver-fields"><label><span>YouTube channel URL</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://youtube.com/@handle" required aria-describedby="resolver-help" /></label>{ownerOptions.length > 0 && <label><span>Owner</span><select value={ownerId} onChange={(event) => setOwnerId(event.target.value)} required disabled={ownerOptions.length === 1}><option value="">Select owner</option>{ownerOptions.map((owner) => <option key={text(owner, "id")} value={text(owner, "id")}>{text(owner, "name", "display_name") || text(owner, "id")}</option>)}</select></label>}<label><span>Maximum video age</span><span className="admin-number-input"><input type="number" min="1" max="365" value={maxAge} onChange={(event) => setMaxAge(Math.min(365, Math.max(1, Number(event.target.value))))} required /><i>days</i></span></label></div>
    <p id="resolver-help" className={`admin-resolver-help ${state === "error" ? "error" : ""}`} role={state === "error" ? "alert" : undefined}>{state === "loading" ? "Resolving channel…" : error || "Paste an exact @handle or /channel/ URL. Generic name search is intentionally unavailable."}</p>
    {resolved && <div className="admin-resolved">
      {text(resolved, "thumbnail_url", "thumbnail") ? <img src={text(resolved, "thumbnail_url", "thumbnail")} alt="" /> : <span className="admin-thumbnail-fallback">{text(resolved, "name", "title").slice(0, 1)}</span>}
      <div><strong>{text(resolved, "name", "title") || "Resolved channel"}</strong><p>{text(resolved, "description") || "No public description supplied."}</p><small>{compactNumber(value(resolved, "subscriber_count"))} subscribers · {compactNumber(value(resolved, "public_video_count", "video_count"))} public videos</small></div>
      <button className="admin-primary" disabled={busy || (existing && active) || (ownerOptions.length > 1 && !ownerId)}>{busy ? "Saving…" : existing && !active ? "Reactivate" : existing ? "Already active" : "Add channel"}<Icon name="arrow" /></button>
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
  const columns = tab === "channels" ? 7 : tab === "videos" ? 8 : 7;
  return <div className="admin-table-wrap" tabIndex={0} aria-label={tab + " records table, scroll for more columns"}><table className={["admin-table", tab, ...hiddenColumns.map((column) => "hide-" + column)].join(" ")}><thead><tr>
    {tab === "channels" && <><th>Channel</th><th>Owner</th><th>Tracking</th><th>Video window</th><th className="optional-column col-channel-videos">Videos</th><th>Sync & backfill</th><th><span className="sr-only">Actions</span></th></>}
    {tab === "videos" && <><th>Video</th><th>Channel</th><th>Published</th><th className="optional-column col-video-ingested">Ingested</th><th className="optional-column col-video-duration">Duration</th><th className="optional-column col-video-views">Views</th><th>Embedding</th><th><span className="sr-only">Actions</span></th></>}
    {tab === "recommendations" && <><th>Recipient</th><th>Video</th><th className="optional-column col-recommendation-rationale">Rationale</th><th>Delivery</th><th>Rating</th><th className="optional-column col-recommendation-timeline">Timeline</th><th><span className="sr-only">Actions</span></th></>}
  </tr></thead><tbody>{loading ? <LoadingRows columns={columns} /> : data.items.map((item) => <RecordRow key={text(item, "id")} tab={tab} item={item} busy={mutationId === text(item, "id")} open={open} patchChannel={patchChannel} />)}</tbody></table></div>;
}

function RecordRow({ tab, item, busy, open, patchChannel }: { tab: Tab; item: JsonRecord; busy: boolean; open: (kind: Tab, item: JsonRecord, trigger: HTMLElement) => void; patchChannel: (item: JsonRecord, patch: JsonRecord) => void }) {
  const active = value(item, "is_active", "active") !== false;
  if (tab === "channels") return <tr className={!active ? "inactive-row" : ""}>
    <td><div className="admin-record-title">{text(item, "thumbnail_url", "thumbnail") ? <img src={text(item, "thumbnail_url", "thumbnail")} alt="" /> : <span>{text(item, "name").slice(0, 1)}</span>}<div><strong>{text(item, "name")}</strong><a href={text(item, "url", "canonical_url")} target="_blank" rel="noreferrer">Open YouTube</a></div></div></td>
    <td>{text(item, "owner_name", "user_display_name", "user_id") || "Default user"}</td><td><Status>{active ? "Active" : "Stopped"}</Status></td>
    <td><ChannelAgeControl item={item} save={patchChannel} /></td>
    <td className="optional-column col-channel-videos">{numberValue(item, "ingested_video_count", "video_count").toLocaleString()}</td><td><strong>{text(item, "sync_status", "last_sync_status") || "Waiting"}</strong><small>Last sync {localTime(value(item, "last_sync_completed_at", "last_ingestion_at"), "not recorded")}</small><small>{text(item, "backfill_status", "backfill_progress") || "Backfill not started"}</small>{text(item, "sync_error", "last_sync_error") && <small className="error-text">{text(item, "sync_error", "last_sync_error")}</small>}</td>
    <td className="admin-row-actions"><button className="admin-text-button" disabled={busy} onClick={() => void patchChannel(item, { is_active: !active })}>{busy ? "Saving…" : active ? "Stop" : "Restore"}</button><button className="admin-details-button" onClick={(event) => void open(tab, item, event.currentTarget)}>Details</button></td>
  </tr>;
  if (tab === "videos") return <tr>
    <td><div className="admin-record-title">{text(item, "thumbnail_url", "thumbnail") ? <img src={text(item, "thumbnail_url", "thumbnail")} alt="" /> : <span /> }<div><strong>{text(item, "title")}</strong><a href={text(item, "youtube_url", "url")} target="_blank" rel="noreferrer">Watch video</a></div></div></td><td>{text(item, "channel_name")}</td><td><time title={text(item, "published_at")}>{localTime(value(item, "published_at"), "—")}</time></td><td className="optional-column col-video-ingested"><time title={text(item, "created_at", "ingested_at")}>{localTime(value(item, "ingested_at", "created_at"), "—")}</time></td><td className="optional-column col-video-duration">{duration(value(item, "duration_seconds"))}</td><td className="optional-column col-video-views">{compactNumber(value(item, "view_count", "views"))}</td><td>{value(item, "similarity") !== null && <strong>{numberValue(item, "similarity").toFixed(3) + " semantic similarity"}</strong>}<Status>{booleanValue(item, "has_embedding") || Boolean(value(item, "embedding_model")) ? text(item, "embedding_model") || "Embedded" : "Missing"}</Status><small>{numberValue(item, "recommendation_count")} recommendations</small></td><td><button className="admin-details-button" onClick={(event) => void open(tab, item, event.currentTarget)}>Details</button></td>
  </tr>;
  const delivered = Boolean(value(item, "delivered_at"));
  return <tr><td><strong>{text(item, "recipient_name", "user_display_name", "display_name") || "Recipient"}</strong><small>{text(item, "telegram_user_id", "telegram_id")}</small></td><td><strong>{text(item, "video_title", "title")}</strong><small>{text(item, "channel_name")}</small></td><td className="optional-column col-recommendation-rationale"><span className="admin-clamp">{text(item, "rationale")}</span></td><td><Status>{delivered ? "Delivered" : "Queued"}</Status></td><td><Status>{text(item, "rating") || "Unrated"}</Status></td><td className="optional-column col-recommendation-timeline"><small>Created {localTime(value(item, "created_at"))}</small><small>{delivered ? `Delivered ${localTime(value(item, "delivered_at"))}` : "Awaiting delivery"}</small>{value(item, "clicked_at") && <small>Clicked {localTime(value(item, "clicked_at"))}</small>}</td><td><button className="admin-details-button" onClick={(event) => void open(tab, item, event.currentTarget)}>Details</button></td></tr>;
}
