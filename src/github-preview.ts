import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubPreviewConfig, KeepAliveConfig, Logger } from "./types.js";

const execFileP = promisify(execFile);

// Kept for backward-compat with existing tests / tooling that parse deployment comments.
export interface GitHubIssueComment {
  id: string;
  body: string;
  updatedAt: string;
}

export interface GitHubClient {
  /** Returns the PR numbers of all currently open pull requests. */
  listOpenPullRequests(config: GitHubPreviewConfig): Promise<number[]>;
}

export interface PreviewPinger {
  ping(url: string, timeoutMs: number): Promise<number>;
}

interface OpenPRPayload {
  number?: number;
}

interface TrackedPreview {
  prNumber: number;
  url: string;
  lastPingAtMs: number | null;
  forcePing: boolean;
}

export interface ExtractedPreviewDeployment {
  prNumber: number;
  url: string;
}

export function buildIssueCommentsApiArgs(config: GitHubPreviewConfig): string[] {
  return [
    "-X", "GET",
    `repos/${config.repoOwner}/${config.repoName}/issues/comments`,
    "--field", `per_page=${config.commentPollLimit}`,
    "--field", "sort=updated",
    "--field", "direction=desc",
  ];
}

export interface GitHubPreviewWarmerOptions {
  config: GitHubPreviewConfig;
  logger: Logger;
  githubClient?: GitHubClient;
  pinger?: PreviewPinger;
  now?: () => number;
}

export function extractPreviewDeployment(
  body: string,
  commentPattern: string,
  urlTemplate: string,
): ExtractedPreviewDeployment | null {
  if (!body || !commentPattern || !urlTemplate) return null;

  let regex: RegExp;
  try {
    regex = new RegExp(commentPattern, "i");
  } catch {
    return null;
  }

  const match = regex.exec(body);
  const prGroup = match?.groups?.pr;
  const prRaw = prGroup ?? match?.[1] ?? "";
  const prNumber = Number.parseInt(prRaw, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) return null;

  return {
    prNumber,
    url: urlTemplate.replaceAll("{{pr}}", String(prNumber)),
  };
}

export class GitHubPreviewWarmer {
  private readonly cfg: GitHubPreviewConfig;
  private readonly log: Logger;
  private readonly github: GitHubClient;
  private readonly pinger: PreviewPinger;
  private readonly now: () => number;
  private readonly tracked = new Map<number, TrackedPreview>();
  private cycleInFlight = false;

  constructor(opts: GitHubPreviewWarmerOptions) {
    this.cfg = opts.config;
    this.log = opts.logger;
    this.github = opts.githubClient ?? new GhCliGitHubClient();
    this.pinger = opts.pinger ?? new FetchPreviewPinger();
    this.now = opts.now ?? Date.now;
  }

  async reconcile(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.cycleInFlight) return;
    const hour = new Date(this.now()).getHours();
    if (hour < 7 || hour >= 19) return;

    this.cycleInFlight = true;
    try {
      await this.refreshTrackedPreviews();
      await this.warmTrackedPreviews();
    } finally {
      this.cycleInFlight = false;
    }
  }

  getTrackedPreviewCount(): number {
    return this.tracked.size;
  }

  private async refreshTrackedPreviews(): Promise<void> {
    let openPRNumbers: number[];
    try {
      openPRNumbers = await this.github.listOpenPullRequests(this.cfg);
    } catch (e) {
      this.log.warn(`GitHub open PR poll failed: ${fmtErr(e)}`);
      return;
    }

    const openSet = new Set(openPRNumbers);

    // Add newly opened PRs.
    for (const prNumber of openPRNumbers) {
      const url = this.cfg.urlTemplate.replaceAll("{{pr}}", String(prNumber));
      const existing = this.tracked.get(prNumber);
      if (!existing) {
        this.tracked.set(prNumber, { prNumber, url, lastPingAtMs: null, forcePing: true });
        this.log.info("Registered preview deployment", { pr_number: String(prNumber), url });
      } else if (existing.url !== url) {
        existing.url = url;
        existing.forcePing = true;
      }
    }

    // Remove PRs that have closed.
    for (const [prNumber, preview] of this.tracked) {
      if (!openSet.has(prNumber)) {
        this.tracked.delete(prNumber);
        this.log.info("Stopped preview keepalive", { pr_number: String(prNumber), url: preview.url, reason: "pr_closed" });
      }
    }
  }

  private async warmTrackedPreviews(): Promise<void> {
    for (const [prNumber, preview] of this.tracked) {
      const due = preview.forcePing ||
        preview.lastPingAtMs === null ||
        this.now() - preview.lastPingAtMs >= this.cfg.keepAliveIntervalMs;
      if (!due) continue;

      try {
        const status = await this.pinger.ping(preview.url, this.cfg.requestTimeoutMs);
        preview.lastPingAtMs = this.now();
        preview.forcePing = false;
        this.log.info("Warmed preview deployment", {
          pr_number: String(prNumber),
          url: preview.url,
          status: String(status),
        });
      } catch (e) {
        this.log.warn(`Preview warm failed for #${prNumber}: ${fmtErr(e)}`, {
          pr_number: String(prNumber),
          url: preview.url,
        });
      }
    }
  }
}

class GhCliGitHubClient implements GitHubClient {
  async listOpenPullRequests(config: GitHubPreviewConfig): Promise<number[]> {
    const stdout = await ghApi([
      "-X", "GET",
      `repos/${config.repoOwner}/${config.repoName}/pulls`,
      "--field", "state=open",
      "--field", "per_page=100",
    ], config.requestTimeoutMs);
    const payload = JSON.parse(stdout) as OpenPRPayload[];
    if (!Array.isArray(payload)) return [];
    return payload
      .filter((pr): pr is { number: number } => typeof pr.number === "number")
      .map(pr => pr.number);
  }
}

class FetchPreviewPinger implements PreviewPinger {
  async ping(url: string, timeoutMs: number): Promise<number> {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

    return response.status;
  }
}

async function ghApi(args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileP("gh", ["api", ...args], {
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function fmtErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export class StaticUrlWarmer {
  private readonly cfg: KeepAliveConfig;
  private readonly log: Logger;
  private readonly pinger: PreviewPinger;
  private readonly now: () => number;
  private readonly lastPingAtMs = new Map<string, number>();

  constructor(cfg: KeepAliveConfig, logger: Logger, pinger?: PreviewPinger, now?: () => number) {
    this.cfg = cfg;
    this.log = logger;
    this.pinger = pinger ?? new FetchPreviewPinger();
    this.now = now ?? Date.now;
  }

  async reconcile(): Promise<void> {
    const currentMs = this.now();
    const local = new Date(currentMs);
    const day = local.getDay();
    const hour = local.getHours();
    // Weekends only (Sat/Sun), 09:00–16:59 local time.
    if (day !== 0 && day !== 6) return;
    if (hour < 9 || hour >= 17) return;
    for (const url of this.cfg.urls) {
      const last = this.lastPingAtMs.get(url) ?? null;
      if (last !== null && currentMs - last < this.cfg.intervalMs) continue;

      try {
        const status = await this.pinger.ping(url, this.cfg.requestTimeoutMs);
        this.lastPingAtMs.set(url, this.now());
        this.log.info("Warmed static URL", { url, status: String(status) });
      } catch (e) {
        this.log.warn(`Static URL warm failed for ${url}: ${fmtErr(e)}`, { url });
      }
    }
  }
}
