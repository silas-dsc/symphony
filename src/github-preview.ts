import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubPreviewConfig, Logger } from "./types.js";

const execFileP = promisify(execFile);

export interface GitHubIssueComment {
  id: string;
  body: string;
  updatedAt: string;
}

export interface GitHubClient {
  listIssueComments(config: GitHubPreviewConfig): Promise<GitHubIssueComment[]>;
  isPullRequestOpen(config: GitHubPreviewConfig, prNumber: number): Promise<boolean>;
}

export interface PreviewPinger {
  ping(url: string, timeoutMs: number): Promise<number>;
}

interface GitHubCommentApiPayload {
  id?: number | string;
  body?: string | null;
  updated_at?: string;
}

interface PullRequestApiPayload {
  state?: string;
}

interface TrackedPreview {
  prNumber: number;
  url: string;
  sourceCommentId: string;
  sourceUpdatedAt: string;
  lastPingAtMs: number | null;
  forcePing: boolean;
}

export interface ExtractedPreviewDeployment {
  prNumber: number;
  url: string;
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
    let comments: GitHubIssueComment[];
    try {
      comments = await this.github.listIssueComments(this.cfg);
    } catch (e) {
      this.log.warn(`GitHub preview comment poll failed: ${fmtErr(e)}`);
      return;
    }

    comments.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

    for (const comment of comments) {
      const deployment = extractPreviewDeployment(comment.body, this.cfg.commentPattern, this.cfg.urlTemplate);
      if (!deployment) continue;

      const existing = this.tracked.get(deployment.prNumber);
      const isNewSignal = !existing ||
        existing.sourceCommentId !== comment.id ||
        existing.sourceUpdatedAt !== comment.updatedAt ||
        existing.url !== deployment.url;

      this.tracked.set(deployment.prNumber, {
        prNumber: deployment.prNumber,
        url: deployment.url,
        sourceCommentId: comment.id,
        sourceUpdatedAt: comment.updatedAt,
        lastPingAtMs: existing?.lastPingAtMs ?? null,
        forcePing: isNewSignal,
      });

      if (isNewSignal) {
        this.log.info("Registered preview deployment", {
          pr_number: String(deployment.prNumber),
          url: deployment.url,
          comment_id: comment.id,
        });
      }
    }
  }

  private async warmTrackedPreviews(): Promise<void> {
    for (const [prNumber, preview] of this.tracked) {
      let isOpen: boolean;
      try {
        isOpen = await this.github.isPullRequestOpen(this.cfg, prNumber);
      } catch (e) {
        this.log.warn(`GitHub PR state check failed for #${prNumber}: ${fmtErr(e)}`);
        continue;
      }

      if (!isOpen) {
        this.tracked.delete(prNumber);
        this.log.info("Stopped preview keepalive for closed PR", {
          pr_number: String(prNumber),
          url: preview.url,
        });
        continue;
      }

      const due = preview.forcePing ||
        preview.lastPingAtMs === null ||
        this.now() - preview.lastPingAtMs >= this.cfg.keepAliveIntervalMs;
      if (!due) continue;

      const reason = preview.forcePing || preview.lastPingAtMs === null
        ? "deployment_comment"
        : "interval";

      try {
        const status = await this.pinger.ping(preview.url, this.cfg.requestTimeoutMs);
        preview.lastPingAtMs = this.now();
        preview.forcePing = false;
        this.log.info("Warmed preview deployment", {
          pr_number: String(prNumber),
          url: preview.url,
          reason,
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
  async listIssueComments(config: GitHubPreviewConfig): Promise<GitHubIssueComment[]> {
    const stdout = await ghApi(
      [
        `repos/${config.repoOwner}/${config.repoName}/issues/comments`,
        "--field", `per_page=${config.commentPollLimit}`,
        "--field", "sort=updated",
        "--field", "direction=desc",
      ],
      config.requestTimeoutMs,
    );
    const payload = JSON.parse(stdout) as GitHubCommentApiPayload[];
    if (!Array.isArray(payload)) return [];

    return payload
      .filter((comment): comment is Required<Pick<GitHubCommentApiPayload, "id" | "updated_at">> & GitHubCommentApiPayload => (
        comment.id !== undefined && typeof comment.updated_at === "string"
      ))
      .map(comment => ({
        id: String(comment.id),
        body: comment.body ?? "",
        updatedAt: comment.updated_at,
      }));
  }

  async isPullRequestOpen(config: GitHubPreviewConfig, prNumber: number): Promise<boolean> {
    const stdout = await ghApi(
      [`repos/${config.repoOwner}/${config.repoName}/pulls/${prNumber}`],
      config.requestTimeoutMs,
    );
    const payload = JSON.parse(stdout) as PullRequestApiPayload;
    return payload.state === "open";
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