/**
 * Circuit breaker for systemic agent failures.
 *
 * When every agent run fails for the same reason (an expired Claude login, a
 * missing binary, a broken workspace hook…), retrying each ticket on its own
 * backoff just burns attempts silently. The breaker trips on:
 *   - any auth failure (retries can't help until credentials change), or
 *   - the same error `threshold` times in a row across 2+ different tickets.
 *
 * While tripped, the orchestrator dispatches nothing. After `cooldownMs` it goes
 * half-open: one trial agent may start. Success closes the breaker; the same
 * failure re-trips it quietly (the operator was already told once).
 */

export type TripKind = "auth" | "repeated";

export interface BreakerStatus {
  kind: TripKind;
  reason: string;
  since: string;
  half_open: boolean;
  next_trial_at: string | null;
}

export interface FailureOutcome {
  /** True only on the failure that opened a new episode (send one alert). */
  justTripped: boolean;
}

export interface BreakerOptions {
  threshold?: number;
  cooldownMs?: number;
  isAuthError: (error: string) => boolean;
}

export const DEFAULT_FAILURE_THRESHOLD = 4;
export const DEFAULT_COOLDOWN_MS = 10 * 60_000;

/** Errors the orchestrator already handles on its own; never systemic. */
const IGNORED = /^(aborted|claude_blocked|no available orchestrator slots|retry poll failed)/i;

export class FailureBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly isAuth: (error: string) => boolean;
  private streak: { signature: string; count: number; issues: Set<string> } | null = null;
  private trip: { kind: TripKind; reason: string; signature: string; sinceMs: number; openUntilMs: number } | null = null;
  /** An episode lasts from the first trip until a success; one alert per episode. */
  private inEpisode = false;
  private trialRunning = false;

  constructor(opts: BreakerOptions) {
    this.threshold = opts.threshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.isAuth = opts.isAuthError;
  }

  /** May a new agent start now? Marks the half-open trial as taken when it says yes. */
  allowDispatch(now = Date.now()): boolean {
    if (!this.trip) return true;
    if (now < this.trip.openUntilMs || this.trialRunning) return false;
    this.trialRunning = true;
    return true;
  }

  /** True when no new work should start (tripped and not ready for a trial). */
  isPaused(now = Date.now()): boolean {
    return !!this.trip && (now < this.trip.openUntilMs || this.trialRunning);
  }

  /** True when the cooldown just ended and a trial is about to be allowed. */
  readyForTrial(now = Date.now()): boolean {
    return !!this.trip && now >= this.trip.openUntilMs && !this.trialRunning;
  }

  /** Record a successful run. Returns true if this ended a failure episode. */
  recordSuccess(): boolean {
    this.streak = null;
    this.trip = null;
    this.trialRunning = false;
    const ended = this.inEpisode;
    this.inEpisode = false;
    return ended;
  }

  recordFailure(issue: string, error: string, now = Date.now()): FailureOutcome {
    this.trialRunning = false;
    if (IGNORED.test(error)) return { justTripped: false };

    const signature = errorSignature(error);
    if (this.streak?.signature === signature) {
      this.streak.count += 1;
      this.streak.issues.add(issue);
    } else {
      this.streak = { signature, count: 1, issues: new Set([issue]) };
    }

    let kind: TripKind | null = null;
    if (this.isAuth(error)) kind = "auth";
    else if (this.streak.count >= this.threshold && this.streak.issues.size >= 2) kind = "repeated";
    else if (this.trip && this.trip.signature === signature) kind = this.trip.kind; // half-open trial failed the same way
    if (!kind) {
      // A different error during a trial: stay tripped and wait out another cooldown.
      if (this.trip) this.trip.openUntilMs = now + this.cooldownMs;
      return { justTripped: false };
    }

    this.trip = {
      kind,
      reason: oneLine(error),
      signature,
      sinceMs: this.trip?.sinceMs ?? now,
      openUntilMs: now + this.cooldownMs,
    };
    const justTripped = !this.inEpisode;
    this.inEpisode = true;
    return { justTripped };
  }

  status(now = Date.now()): BreakerStatus | null {
    if (!this.trip) return null;
    const halfOpen = now >= this.trip.openUntilMs;
    return {
      kind: this.trip.kind,
      reason: this.trip.reason,
      since: new Date(this.trip.sinceMs).toISOString(),
      half_open: halfOpen,
      next_trial_at: halfOpen ? null : new Date(this.trip.openUntilMs).toISOString(),
    };
  }
}

/** Collapse ids, numbers, paths and hashes so the same failure on different tickets matches. */
export function errorSignature(error: string): string {
  return oneLine(error)
    .toLowerCase()
    .replace(/\b[a-z]+-\d+\b/g, "#id")
    .replace(/(?:\/[\w.@-]+)+/g, "/path")
    .replace(/\b[0-9a-f]{7,}\b/g, "#hex")
    .replace(/\d+/g, "#")
    .slice(0, 160);
}

function oneLine(s: string): string {
  return redactSecrets(s).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Belt and braces: never let a token-shaped string reach a log line or Slack. */
export function redactSecrets(s: string): string {
  return s.replace(/\b(sk-ant-|xox[abposr]-|xapp-|gh[pousr]_|github_pat_|lin_api_)[A-Za-z0-9_-]+/g, "$1[redacted]");
}

/** Credentials the spawned `claude` CLI reads; refreshed from .env before a half-open trial. */
export const AUTH_ENV_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/**
 * Copy the auth keys from a parsed .env into `env`, so fixing .env takes effect
 * without a restart (dotenv only loads .env once, at startup). Returns the names
 * of keys that changed — never their values.
 */
export function refreshAuthEnv(parsed: Record<string, string>, env: NodeJS.ProcessEnv = process.env): string[] {
  const changed: string[] = [];
  for (const key of AUTH_ENV_KEYS) {
    const value = parsed[key];
    if (value && env[key] !== value) {
      env[key] = value;
      changed.push(key);
    }
  }
  return changed;
}
