"use client";
/* eslint-disable @next/next/no-location-assign-relative-destination -- Clear the full in-memory account state after sign-out or deletion. */
import Link from "next/link";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth/client";

type Revision = { version: number; preference_statement: string; source: string; created_at: string };
type Account = { id: string; email: string; display_name: string; telegram_connected: boolean; delivery_paused: boolean; delivery_status?: string; delivery_error?: string | null; onboarding_completed?: boolean };

function GoogleLogo() {
  return <svg className="google-logo" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.797 2.716v2.258h2.909c1.703-1.568 2.684-3.878 2.684-6.614Z"/><path fill="#34A853" d="M9 18c2.43 0 4.468-.806 5.956-2.181l-2.909-2.258c-.806.54-1.836.859-3.047.859-2.344 0-4.328-1.584-5.037-3.71H.956v2.332A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.963 10.71A5.41 5.41 0 0 1 3.682 9c0-.594.102-1.172.281-1.71V4.958H.956A9 9 0 0 0 0 9c0 1.453.348 2.828.956 4.042l3.007-2.332Z"/><path fill="#EA4335" d="M9 3.58c1.322 0 2.508.454 3.441 1.346l2.581-2.581C13.464.892 11.426 0 9 0A9 9 0 0 0 .956 4.958L3.963 7.29C4.672 5.164 6.656 3.58 9 3.58Z"/></svg>;
}

export function SignInPrompt() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [credentialMode, setCredentialMode] = useState<"sign-in" | "create">("sign-in");
  async function signIn() {
    setBusy("google"); setError("");
    try { const result = await authClient.signIn.social({ provider: "google", callbackURL: `${window.location.origin}/auth/callback` }); if (result.error) throw new Error("Sign-in could not start. Please try again."); }
    catch { setError("Google sign-in is unavailable right now. Please try again."); setBusy(""); }
  }
  async function submitEmailCredentials(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim();
    setBusy(credentialMode); setError("");
    try {
      const result = credentialMode === "create"
        ? await authClient.signUp.email({ email, password, name })
        : await authClient.signIn.email({ email, password });
      if (result.error) throw new Error();
      window.location.assign("/onboarding");
    } catch {
      setError(credentialMode === "create" ? "Account creation failed. Check the details or sign in if this account already exists." : "Sign-in failed. Check the email and password, then try again.");
      setBusy("");
    }
  }
  return <main className="sign-in-page"><Link className="signal-wordmark" href="/"><span aria-hidden="true">F/</span>Finite Feed</Link><h1>A feed with<br /><span>you in mind.</span></h1><p>Sign in to choose your interests, connect Telegram, and find your next worthwhile watch.</p><section className="sign-in-methods" aria-label="Sign-in options"><div className="google-auth-option"><h2>Use Google</h2><button className="google-signin" disabled={!!busy} onClick={() => void signIn()}><GoogleLogo />{busy === "google" ? "Opening Google…" : "Continue with Google"}</button></div><div className="email-auth-option"><div className="email-auth-heading"><h2>Use email</h2><div className="email-auth-modes" aria-label="Email account action"><button type="button" disabled={!!busy} aria-pressed={credentialMode === "sign-in"} onClick={() => { setCredentialMode("sign-in"); setError(""); }}>Sign in</button><button type="button" disabled={!!busy} aria-pressed={credentialMode === "create"} onClick={() => { setCredentialMode("create"); setError(""); }}>Create account</button></div></div><form onSubmit={(event) => void submitEmailCredentials(event)}>{credentialMode === "create" && <><label htmlFor="account-name">Name</label><input id="account-name" name="name" autoComplete="name" required /></>}<label htmlFor="account-email">Email</label><input id="account-email" name="email" type="email" autoComplete="email" required /><label htmlFor="account-password">Password</label><input key={credentialMode} id="account-password" name="password" type="password" autoComplete={credentialMode === "create" ? "new-password" : "current-password"} minLength={8} required /><button className="email-auth-submit" disabled={!!busy}>{busy === credentialMode ? credentialMode === "create" ? "Creating account…" : "Signing in…" : credentialMode === "create" ? "Create account" : "Sign in with email"}</button></form></div></section>{error && <p className="signal-error" role="alert">{error}</p>}<p className="landing-note">Private beta. By continuing, you can review and manage your account data in settings.</p><Link href="/privacy">Privacy & your data</Link></main>;
}

export function AccountControls() {
  const [history, setHistory] = useState<Revision[] | null>(null);
  const [historyError, setHistoryError] = useState(false);
  async function loadHistory() { try { const response = await fetch("/api/personal/account/preferences", {cache: "no-store"}); if (!response.ok) throw new Error(); setHistory(await response.json()); setHistoryError(false); } catch { setHistoryError(true); } }
  const [account, setAccount] = useState<Account | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState("");
  const [telegramLink, setTelegramLink] = useState<{url:string;expires_at:string} | null>(null);
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
      if (name === "link") { setTelegramLink(await response.json()); setMessage("Open Telegram and press Start, then refresh your account here to confirm the connection."); }
      else if (name === "export") { const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "finite-feed-account.json"; link.click(); URL.revokeObjectURL(url); setMessage("Your account export is downloaded."); }
      else if (name === "delete") { await authClient.signOut(); window.location.assign("/"); }
      else { setTelegramLink(null); await loadAccount(); setMessage(name === "unlink" ? "Telegram disconnected. Reconnect whenever you are ready." : "Delivery preference saved."); }
    } catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : "Something went wrong. Try again."); }
    finally { setBusy(""); }
  }
  async function signOut() { setBusy("logout"); try { const result = await authClient.signOut(); if (result.error) throw new Error(); window.location.assign("/"); } catch { setError(true); setMessage("Sign-out failed. Please try again."); setBusy(""); } }
  return <section className="account-sheet" aria-labelledby="account-heading"><div><h2 id="account-heading">Your account</h2>{account ? <><p className="account-identity"><strong>{account.display_name || account.email}</strong><br />{account.email}</p><button className="cancel-action" onClick={() => void signOut()} disabled={!!busy}>Sign out</button></> : <p role="status">{message || "Loading your account…"}</p>}</div><div><h2>Telegram delivery</h2><p>{account ? account.telegram_connected ? "Telegram is connected." : "Connect Telegram to receive your recommendations." : "Checking connection…"} {account?.delivery_paused ? "Delivery is paused." : ""}</p>{account?.delivery_status && <p>Last delivery: {account.delivery_status.replaceAll("_", " ")}{account.delivery_error ? `. ${account.delivery_error}` : ""}</p>}<div className="account-actions"><button className="save-action" onClick={() => void action("link", "account/telegram-link")} disabled={!!busy || !account}>{busy === "link" ? "Preparing link…" : account?.telegram_connected ? "Reconnect Telegram" : "Connect Telegram"}</button><button className="cancel-action" onClick={() => void loadAccount()} disabled={!!busy}>Refresh account</button>{account?.telegram_connected && <button className="cancel-action" disabled={!!busy} onClick={() => void action("unlink", "account/telegram", "DELETE")}>Disconnect</button>}{account && <button className="cancel-action" disabled={!!busy} onClick={() => void action("pause", "account/delivery", "PUT", { paused: !account.delivery_paused })}>{account.delivery_paused ? "Resume delivery" : "Pause delivery"}</button>}</div>{telegramLink && <p><a className="landing-cta" href={telegramLink.url} target="_blank" rel="noreferrer">Open Telegram</a><br />This one-use link expires {new Date(telegramLink.expires_at).toLocaleTimeString()}.</p>}</div>{message && <p className={error ? "signal-error account-message" : "signal-notice account-message"} role={error ? "alert" : "status"}>{message}</p>}<details className="account-data" onToggle={(event) => { if (event.currentTarget.open) void loadHistory(); }}><summary>Preference history</summary>{historyError ? <p role="alert">History could not load. <button onClick={() => void loadHistory()}>Try again</button></p> : history ? history.length ? history.map((revision) => <article key={revision.version}><h3>Version {revision.version}</h3><p>{revision.preference_statement}</p><p className="landing-note">{revision.source} · {new Date(revision.created_at).toLocaleDateString()}</p></article>) : <p>No preference changes yet. Shape your memory below to get started.</p> : <p>Loading preference history…</p>}</details><details className="account-data"><summary>Your data & account deletion</summary><p>Export your personal records at any time. Deleting your account removes its personal records and disconnects Telegram. Previously sent Telegram messages remain in your chat. <Link href="/privacy">Read about retention.</Link></p><div className="account-actions"><button className="cancel-action" disabled={!!busy} onClick={() => void action("export", "account/export", "GET")}>Export account data</button><button className="cancel-action" disabled={!!busy} onClick={() => setDeleting(!deleting)}>Delete account…</button></div>{deleting && <form className="delete-confirmation" onSubmit={(event) => { event.preventDefault(); if (confirmation === "DELETE") void action("delete", "account", "DELETE", { confirmation }); }}><label htmlFor="delete-confirmation">This cannot be undone. Type DELETE to confirm.</label><input id="delete-confirmation" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /><button className="save-action" disabled={confirmation !== "DELETE" || !!busy}>{busy === "delete" ? "Deleting…" : "Permanently delete my account"}</button></form>}</details></section>;
}
