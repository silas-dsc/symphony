import { describe, it, expect } from "vitest";
import {
  buildIssueCommentsApiArgs,
  GitHubPreviewWarmer,
  extractPreviewDeployment,
  type GitHubClient,
  type PreviewPinger,
  type LinearClient,
} from "../github-preview.js";
import type { GitHubPreviewConfig, Logger } from "../types.js";

function createConfig(overrides?: Partial<GitHubPreviewConfig>): GitHubPreviewConfig {
  return {
    enabled: true,
    repoOwner: "team-dsc",
    repoName: "team-dsc",
    commentPattern: "deployed to .*? - Team DSC Production Preview \\(Web\\) PR #(?<pr>\\d+)",
    urlTemplate: "https://team-dsc-production-preview-web-pr-{{pr}}.onrender.com/",
    commentPollLimit: 100,
    keepAliveIntervalMs: 180000,
    requestTimeoutMs: 30000,
    inReviewStates: [],
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
      url: "https://team-dsc-production-preview-web-pr-933.onrender.com/",
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
    const comments = [
      {
        id: "comment-1",
        body: "silas-dsc deployed to feature/tea-4020-bulk-certificate-download - Team DSC Production Preview (Web) PR #933",
        updatedAt: "2026-05-12T10:00:00Z",
      },
    ];
    const pullRequestStates = new Map<number, boolean>([[933, true]]);
    const pinged: Array<{ atMs: number; url: string }> = [];
    let nowMs = 0;

    const githubClient: GitHubClient = {
      listIssueComments: async () => comments,
      isPullRequestOpen: async (_config, prNumber) => pullRequestStates.get(prNumber) ?? false,
      getPullRequestHeadBranch: async () => null,
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

    await warmer.reconcile();
    expect(pinged).toEqual([
      { atMs: 0, url: "https://team-dsc-production-preview-web-pr-933.onrender.com/" },
    ]);
    expect(warmer.getTrackedPreviewCount()).toBe(1);

    nowMs = 60_000;
    await warmer.reconcile();
    expect(pinged).toHaveLength(1);

    comments[0] = {
      ...comments[0],
      id: "comment-2",
      updatedAt: "2026-05-12T10:01:00Z",
    };
    await warmer.reconcile();
    expect(pinged).toEqual([
      { atMs: 0, url: "https://team-dsc-production-preview-web-pr-933.onrender.com/" },
      { atMs: 60_000, url: "https://team-dsc-production-preview-web-pr-933.onrender.com/" },
    ]);

    nowMs = 240_000;
    await warmer.reconcile();
    expect(pinged).toEqual([
      { atMs: 0, url: "https://team-dsc-production-preview-web-pr-933.onrender.com/" },
      { atMs: 60_000, url: "https://team-dsc-production-preview-web-pr-933.onrender.com/" },
      { atMs: 240_000, url: "https://team-dsc-production-preview-web-pr-933.onrender.com/" },
    ]);

    pullRequestStates.set(933, false);
    nowMs = 420_000;
    await warmer.reconcile();
    expect(pinged).toHaveLength(3);
    expect(warmer.getTrackedPreviewCount()).toBe(0);
  });

  it("stops warming when Linear ticket leaves In Review state", async () => {
    const comments = [
      {
        id: "comment-1",
        body: "silas-dsc deployed to feature/tea-4020-bulk-certificate-download - Team DSC Production Preview (Web) PR #933",
        updatedAt: "2026-05-12T10:00:00Z",
      },
    ];
    const pinged: Array<{ atMs: number; url: string }> = [];
    let nowMs = 0;

    // Linear reports branch is "In Review" initially
    let reviewBranches = new Set(["feature/tea-4020-bulk-certificate-download"]);

    const githubClient: GitHubClient = {
      listIssueComments: async () => comments,
      isPullRequestOpen: async () => true,
      getPullRequestHeadBranch: async (_config, prNumber) =>
        prNumber === 933 ? "feature/tea-4020-bulk-certificate-download" : null,
    };
    const linearClient: LinearClient = {
      listBranchesInStates: async () => Array.from(reviewBranches),
    };
    const pinger: PreviewPinger = {
      ping: async (url) => {
        pinged.push({ atMs: nowMs, url });
        return 200;
      },
    };

    const warmer = new GitHubPreviewWarmer({
      config: createConfig({ inReviewStates: ["In Review"] }),
      logger: createLogger(),
      githubClient,
      pinger,
      linearClient,
      now: () => nowMs,
    });

    // Initial ping when deploy comment found and ticket is In Review
    await warmer.reconcile();
    expect(pinged).toHaveLength(1);
    expect(warmer.getTrackedPreviewCount()).toBe(1);

    // Still In Review — interval not yet elapsed, no ping
    nowMs = 60_000;
    await warmer.reconcile();
    expect(pinged).toHaveLength(1);

    // Still In Review — interval elapsed, ping again
    nowMs = 240_000;
    await warmer.reconcile();
    expect(pinged).toHaveLength(2);

    // Ticket moves out of In Review (e.g. merged → Done, or back to Dev in Progress)
    reviewBranches = new Set();
    nowMs = 420_000;
    await warmer.reconcile();
    expect(pinged).toHaveLength(2);
    expect(warmer.getTrackedPreviewCount()).toBe(0);
  });

  it("falls back to GitHub PR open check when Linear check fails", async () => {
    const comments = [
      {
        id: "comment-1",
        body: "silas-dsc deployed to feature/tea-4020-bulk-certificate-download - Team DSC Production Preview (Web) PR #933",
        updatedAt: "2026-05-12T10:00:00Z",
      },
    ];
    const pinged: Array<string> = [];
    const pullRequestStates = new Map<number, boolean>([[933, true]]);

    const githubClient: GitHubClient = {
      listIssueComments: async () => comments,
      isPullRequestOpen: async (_config, prNumber) => pullRequestStates.get(prNumber) ?? false,
      getPullRequestHeadBranch: async () => null,
    };
    const linearClient: LinearClient = {
      listBranchesInStates: async () => { throw new Error("Linear unavailable"); },
    };
    const pinger: PreviewPinger = {
      ping: async (url) => { pinged.push(url); return 200; },
    };

    const warmer = new GitHubPreviewWarmer({
      config: createConfig({ inReviewStates: ["In Review"] }),
      logger: createLogger(),
      githubClient,
      pinger,
      linearClient,
      now: () => 0,
    });

    // Linear fails → falls back to GitHub PR open check → PR is open → warms
    await warmer.reconcile();
    expect(pinged).toHaveLength(1);
    expect(warmer.getTrackedPreviewCount()).toBe(1);

    // PR closes → stops even in fallback mode
    pullRequestStates.set(933, false);
    await warmer.reconcile();
    expect(warmer.getTrackedPreviewCount()).toBe(0);
  });
});
