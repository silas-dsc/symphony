import { describe, it, expect } from "vitest";
import {
  buildIssueCommentsApiArgs,
  GitHubPreviewWarmer,
  extractPreviewDeployment,
  type GitHubClient,
  type PreviewPinger,
} from "../github-preview.js";
import type { GitHubPreviewConfig, Logger } from "../types.js";

function createConfig(overrides?: Partial<GitHubPreviewConfig>): GitHubPreviewConfig {
  return {
    enabled: true,
    repoOwner: "team-dsc",
    repoName: "team-dsc",
    commentPattern: "deployed to .*? - Team DSC Production Preview \\(Web\\) PR #(?<pr>\\d+)",
    urlTemplate: "https://team-dsc-production-preview-web-pr-{{pr}}.onrender.com/health-check",
    commentPollLimit: 100,
    keepAliveIntervalMs: 780000,
    requestTimeoutMs: 30000,
    ...overrides,
  };
}

function createLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

describe("extractPreviewDeployment", () => {
  it("parses the PR number and preview URL from a deployment comment", () => {
    const deployment = extractPreviewDeployment(
      "silas-dsc deployed to feature/tea-4020-bulk-certificate-download - Team DSC Production Preview (Web) PR #933",
      createConfig().commentPattern,
      createConfig().urlTemplate,
    );

    expect(deployment).toEqual({
      prNumber: 933,
      url: "https://team-dsc-production-preview-web-pr-933.onrender.com/health-check",
    });
  });

  it("ignores unrelated comments", () => {
    expect(extractPreviewDeployment("looks good to me", createConfig().commentPattern, createConfig().urlTemplate)).toBeNull();
  });

  it("builds a GET request for issue comment polling", () => {
    expect(buildIssueCommentsApiArgs(createConfig())).toEqual([
      "-X",
      "GET",
      "repos/team-dsc/team-dsc/issues/comments",
      "--field",
      "per_page=100",
      "--field",
      "sort=updated",
      "--field",
      "direction=desc",
    ]);
  });
});

describe("GitHubPreviewWarmer", () => {
  it("warms immediately, re-warms on interval, and stops after PR close", async () => {
    let openPRs: number[] = [933];
    const pinged: Array<{ atMs: number; url: string }> = [];
    let nowMs = 0;

    const githubClient: GitHubClient = {
      listOpenPullRequests: async () => openPRs,
    };
    const pinger: PreviewPinger = {
      ping: async (url) => {
        pinged.push({ atMs: nowMs, url });
        return 200;
      },
    };

    const warmer = new GitHubPreviewWarmer({
      config: createConfig(),
      logger: createLogger(),
      githubClient,
      pinger,
      now: () => nowMs,
    });

    // First cycle: PR discovered, force-pinged immediately.
    await warmer.reconcile();
    expect(pinged).toEqual([
      { atMs: 0, url: "https://team-dsc-production-preview-web-pr-933.onrender.com/health-check" },
    ]);
    expect(warmer.getTrackedPreviewCount()).toBe(1);

    // Interval not yet elapsed — no ping.
    nowMs = 60_000;
    await warmer.reconcile();
    expect(pinged).toHaveLength(1);

    // Interval elapsed — ping.
    nowMs = 840_000;
    await warmer.reconcile();
    expect(pinged).toEqual([
      { atMs: 0, url: "https://team-dsc-production-preview-web-pr-933.onrender.com/health-check" },
      { atMs: 840_000, url: "https://team-dsc-production-preview-web-pr-933.onrender.com/health-check" },
    ]);

    // PR closed: remove it from the open list.
    openPRs = [];
    nowMs = 1_680_000;
    await warmer.reconcile();
    expect(pinged).toHaveLength(2);
    expect(warmer.getTrackedPreviewCount()).toBe(0);
  });

  it("tracks multiple open PRs independently", async () => {
    const pinged: string[] = [];

    const githubClient: GitHubClient = {
      listOpenPullRequests: async () => [933, 940, 955],
    };
    const pinger: PreviewPinger = {
      ping: async (url) => { pinged.push(url); return 200; },
    };

    const warmer = new GitHubPreviewWarmer({
      config: createConfig(),
      logger: createLogger(),
      githubClient,
      pinger,
      now: () => 0,
    });

    await warmer.reconcile();
    expect(pinged).toHaveLength(3);
    expect(pinged).toContain("https://team-dsc-production-preview-web-pr-933.onrender.com/health-check");
    expect(pinged).toContain("https://team-dsc-production-preview-web-pr-940.onrender.com/health-check");
    expect(pinged).toContain("https://team-dsc-production-preview-web-pr-955.onrender.com/health-check");
    expect(warmer.getTrackedPreviewCount()).toBe(3);
  });

  it("does not warm outside 07:00–18:59 local time", async () => {
    const pinged: string[] = [];

    const githubClient: GitHubClient = {
      listOpenPullRequests: async () => [933],
    };
    const pinger: PreviewPinger = {
      ping: async (url) => { pinged.push(url); return 200; },
    };

    // Build a timestamp whose local hour is 0 (midnight) regardless of timezone,
    // so the gate always fires consistently in CI and local dev.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const midnightUtcMs = midnight.getTime();

    const warmer = new GitHubPreviewWarmer({
      config: createConfig(),
      logger: createLogger(),
      githubClient,
      pinger,
      now: () => midnightUtcMs,
    });

    await warmer.reconcile();
    expect(pinged).toHaveLength(0);
    expect(warmer.getTrackedPreviewCount()).toBe(0);
  });
});
