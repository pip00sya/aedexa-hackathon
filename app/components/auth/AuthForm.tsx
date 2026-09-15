"use client";

import { AlertTriangle, ArrowRight, Eye, EyeOff, LoaderCircle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import Mark from "../Mark";

/** Sign in and sign up in one form */

type AuthFormProps = { mode: "login" | "register" };

const COPY = {
  login: {
    eyebrow: "SIGN IN",
    // Non-breaking space
    title: "Welcome back",
    lead: "Sign in to get back to your saved sites.",
    submit: "Sign in",
    swapText: "No account yet?",
    swapLabel: "Create one",
    swapHref: "/register",
  },
  register: {
    eyebrow: "SIGN UP",
    title: "Create an account",
    lead: "An account lets you move projects between devices. Calculations and the archive work without one — they run on your device.",
    submit: "Create account",
    swapText: "Already have an account?",
    swapLabel: "Sign in",
    swapHref: "/login",
  },
} as const;

export default function AuthForm({ mode }: AuthFormProps) {
  const copy = COPY[mode];
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setDone("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, name, email, password }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        account?: { name: string };
      };
      if (!response.ok || !payload.account) {
        setError(payload.error ?? "Something went wrong. Please try again.");
        return;
      }
      setDone(`Hi, ${payload.account.name}. Opening your workspace…`);
      window.location.assign("/app");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Network unavailable.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <div className="auth-card">
        <Link className="auth-brand" href="/">
          <Mark size={36} />
          <strong className="aedexa-mark">AEDEXA</strong>
        </Link>

        <p className="landing-eyebrow">{copy.eyebrow}</p>
        <h1>{copy.title}</h1>
        <p className="auth-lead">{copy.lead}</p>

        <form onSubmit={submit}>
          {mode === "register" && (
            <label className="auth-field">
              <span>Name</span>
              <div className="auth-field-input">
                <input
                  type="text"
                  autoComplete="name"
                  required
                  minLength={2}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            </label>
          )}

          <label className="auth-field">
            <span>Email</span>
            <div className="auth-field-input">
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </label>

          <label className="auth-field">
            <span>Password</span>
            <div className="auth-field-input">
              <input
                type={revealPassword ? "text" : "password"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={mode === "register" ? 10 : undefined}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="auth-field-toggle"
                onClick={() => setRevealPassword((shown) => !shown)}
                aria-label={revealPassword ? "Hide password" : "Show password"}
                aria-pressed={revealPassword}
              >
                {revealPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {mode === "register" && <small>At least 10 characters. Length beats complexity.</small>}
          </label>

          {error && (
            <p className="auth-message error" role="alert">
              <AlertTriangle size={15} />
              <span>{error}</span>
            </p>
          )}
          {done && (
            <p className="auth-message ok" role="status">
              <ShieldCheck size={15} />
              <span>{done}</span>
            </p>
          )}

          <button className="landing-pill large wide" type="submit" disabled={busy}>
            {copy.submit}
            {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
          </button>
        </form>

        <p className="auth-swap">
          {copy.swapText}{" "}
          <Link className="auth-swap-link" href={copy.swapHref}>
            {copy.swapLabel}
          </Link>
        </p>

        <p className="auth-note">
          <ShieldCheck size={14} />
          <span>
            Drawings never leave your browser: all parsing happens locally. Your account stores only
            your email, name, and a password hash.
          </span>
        </p>
      </div>

      <aside className="auth-aside" aria-hidden="true">
        <div className="auth-mark-stage">
          <Mark size={300} className="auth-mark-ghost" />
        </div>
        <p className="auth-aside-quote">The drawing becomes a model</p>
        <Link className="auth-aside-link" href="/app">
          Open workspace without an account <ArrowRight size={15} />
        </Link>
      </aside>
    </main>
  );
}
