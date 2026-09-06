"use client";
/* eslint-disable @next/next/no-location-assign-relative-destination -- Clear the full in-memory account state after sign-out or deletion. */
import Link from "next/link";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth/client";

type Revision = { version: number; preference_statement: string; source: string; created_at: string };
type Account = { id: string; email: string; display_name: string; telegram_connected: boolean; delivery_paused: boolean; delivery_status?: string; delivery_error?: string | null };

export function SignInPrompt() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signIn() {
    setBusy(true); setError("");
    try { const result = await authClient.signIn.social({ provider: "google", callbackURL: `${window.location.origin}/auth/callback` }); if (result.error) throw new Error("Sign-in could not start. Please try again."); }
    catch { setError("Google sign-in is unavailable right now. Please try again."); setBusy(false); }
  }
  return <main className="sign-in-page"><Link className="signal-wordmark" href="/"><span aria-hidden="true">F/</span>Finite Feed</Link><h1>A feed with<br /><span>you in mind.</span></h1><p>Sign in to choose your interests, connect Telegram, and find your next worthwhile watch.</p><button className="landing-cta" disabled={busy} onClick={() => void signIn()}>{busy ? "Opening Google…" : "Continue with Google"}</button>{error && <p className="signal-error" role="alert">{error}</p>}<p className="landing-note">Private beta. By continuing, you can review and manage your account data in settings.</p><Link href="/privacy">Privacy & your data</Link></main>;
}

export function AccountControls() {
  const [history, setHistory] = useState<Revision[] | null>(null);
  const [historyError, setHistoryError] = useState(false);
  async function loadHistory() { try { const response = await fetch("/api/personal/account/preferences", {cache: "no-store"}); if (!response.ok) throw new Error(); setHistory(await response.json()); setHistoryError(false); } catch { setHistoryError(true); } }
  const [account, setAccount] = useState<Account | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState("");
  const [telegramLink, setTelegramLink] = useState<{url:string;code:string;expires_at:string} | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  async function loadAccount() {
    try { const response = await fetch("/api/personal/account", { cache: "no-store" }); if (!response.ok) throw new Error(); setAccount(await response.json()); }
    catch { setError(true); setMessage("Your account could not load. Refresh your account to try again."); }
  }
  useEffect(() => { const timer = setTimeout(() => void loadAccount(), 0); return () => clearTimeout(timer); }, []);
  async function action(name: string, path: string, method = "POST", body?: unknown) {
    setBusy(name); setMessage(""); setError(false);
    try {
      const response = await fetch(`/api/personal/${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(typeof data?.detail === "string" ? data.detail : "That change could not be saved. Please try again."); }
      if (name === "link") { setTelegramLink(await response.json()); setCopiedCode(false); setMessage("Your connection code is ready. Send it to the Finite Feed bot, then refresh here to confirm the connection."); }
      else if (name === "export") { const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "finite-feed-account.json"; link.click(); URL.revokeObjectURL(url); setMessage("Your account export is downloaded."); }
      else if (name === "delete") { await authClient.signOut(); window.location.assign("/"); }
      else { setTelegramLink(null); await loadAccount(); setMessage(name === "unlink" ? "Telegram disconnected. Reconnect whenever you are ready." : "Delivery preference saved."); }
    } catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : "Something went wrong. Try again."); }
    finally { setBusy(""); }
  }
  async function copyTelegramCode() {
    if (!telegramLink) return;
    try {
      await navigator.clipboard.writeText(telegramLink.code);
      setCopiedCode(true);
    } catch {
      try {
        const input = document.createElement("textarea");
        input.value = telegramLink.code;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.append(input);
        input.select();
        const copied = document.execCommand("copy");
        input.remove();
        if (!copied) throw new Error("copy failed");
        setCopiedCode(true);
      } catch {
        setError(true);
        setMessage("The code could not be copied automatically. Select and copy it from the code box.");
      }
    }
  }
  async function signOut() { setBusy("logout"); try { const result = await authClient.signOut(); if (result.error) throw new Error(); window.location.assign("/"); } catch { setError(true); setMessage("Sign-out failed. Please try again."); setBusy(""); } }
  const telegramBot = telegramLink ? new URL(telegramLink.url).pathname.slice(1) : "";
  return <section className="account-sheet" aria-labelledby="account-heading"><div><h2 id="account-heading">Your account</h2>{account ? <><p className="account-identity"><strong>{account.display_name || account.email}</strong><br />{account.email}</p><button className="cancel-action" onClick={() => void signOut()} disabled={!!busy}>Sign out</button></> : <p role="status">{message || "Loading your account…"}</p>}</div><div><h2>Telegram delivery</h2><p>{account ? account.telegram_connected ? "Telegram is connected." : "Connect Telegram to receive your recommendations." : "Checking connection…"} {account?.delivery_paused ? "Delivery is paused." : ""}</p>{account?.delivery_status && <p>Last delivery: {account.delivery_status.replaceAll("_", " ")}{account.delivery_error ? `. ${account.delivery_error}` : ""}</p>}<div className="account-actions"><button className="save-action" onClick={() => void action("link", "account/telegram-link")} disabled={!!busy || !account}>{busy === "link" ? "Preparing code…" : account?.telegram_connected ? "Get a new connection code" : "Connect manually"}</button><button className="cancel-action" onClick={() => void loadAccount()} disabled={!!busy}>Refresh account</button>{account?.telegram_connected && <button className="cancel-action" disabled={!!busy} onClick={() => void action("unlink", "account/telegram", "DELETE")}>Disconnect</button>}{account && <button className="cancel-action" disabled={!!busy} onClick={() => void action("pause", "account/delivery", "PUT", { paused: !account.delivery_paused })}>{account.delivery_paused ? "Resume delivery" : "Pause delivery"}</button>}</div>{telegramLink && <section className="telegram-setup" aria-labelledby="telegram-setup-heading"><h3 id="telegram-setup-heading">Connect in Telegram</h3><ol><li>Open <strong>@{telegramBot}</strong> in Telegram.</li><li>Copy and send this six-digit code as a message.</li><li>Return here and refresh your account.</li></ol><div className="telegram-code"><output aria-label="Your six-digit Telegram connection code">{telegramLink.code}</output><button className="cancel-action" onClick={() => void copyTelegramCode()}>{copiedCode ? "Copied" : "Copy code"}</button></div><p className="landing-note">This code expires {new Date(telegramLink.expires_at).toLocaleTimeString()}.</p><a className="telegram-deep-link" href={telegramLink.url} target="_blank" rel="noreferrer">Prefer a link? Open Telegram instead <span aria-hidden="true">↗</span></a></section>}</div>{message && <p className={error ? "signal-error account-message" : "signal-notice account-message"} role={error ? "alert" : "status"}>{message}</p>}<details className="account-data" onToggle={(event) => { if (event.currentTarget.open) void loadHistory(); }}><summary>Preference history</summary>{historyError ? <p role="alert">History could not load. <button onClick={() => void loadHistory()}>Try again</button></p> : history ? history.length ? history.map((revision) => <article key={revision.version}><h3>Version {revision.version}</h3><p>{revision.preference_statement}</p><p className="landing-note">{revision.source} · {new Date(revision.created_at).toLocaleDateString()}</p></article>) : <p>No preference changes yet. Shape your memory below to get started.</p> : <p>Loading preference history…</p>}</details><details className="account-data"><summary>Your data & account deletion</summary><p>Export your personal records at any time. Deleting your account removes its personal records and disconnects Telegram. Previously sent Telegram messages remain in your chat. <Link href="/privacy">Read about retention.</Link></p><div className="account-actions"><button className="cancel-action" disabled={!!busy} onClick={() => void action("export", "account/export", "GET")}>Export account data</button><button className="cancel-action" disabled={!!busy} onClick={() => setDeleting(!deleting)}>Delete account…</button></div>{deleting && <form className="delete-confirmation" onSubmit={(event) => { event.preventDefault(); if (confirmation === "DELETE") void action("delete", "account", "DELETE", { confirmation }); }}><label htmlFor="delete-confirmation">This cannot be undone. Type DELETE to confirm.</label><input id="delete-confirmation" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /><button className="save-action" disabled={confirmation !== "DELETE" || !!busy}>{busy === "delete" ? "Deleting…" : "Permanently delete my account"}</button></form>}</details></section>;
}
