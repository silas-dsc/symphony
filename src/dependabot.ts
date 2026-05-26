import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DependabotConfig, Logger, TrackerConfig } from "./types.js";
import * as linear from "./linear.js";

const execFileP = promisify(execFile);

/** A GitHub Dependabot security alert, normalised down to the fields a ticket needs. */
export interface DependabotAlert {
  number: number;
  state: string;
  ecosystem: string;
  packageName: string;
  manifestPath: string | null;
  scope: string | null;
  severity: string;
  summary: string;
  description: string;
  ghsaId: string | null;
  cveId: string | null;
  vulnerableRange: string | null;
  firstPatchedVersion: string | null;
  references: string[];
  htmlUrl: string;
}

/** Lists the repo's open Dependabot alerts. Injected so tests don't shell out to `gh`. */
export interface DependabotAlertClient {
  listOpenAlerts(config: DependabotConfig): Promise<DependabotAlert[]>;
}

export interface CreatedTicket {
  identifier: string;
  url: string | null;
}

export interface DependabotTicketSnapshot {
  /** Stable keys (`owner/repo#N`) of alerts that already have a Linear ticket, in any state. Used to dedupe. */
  existingKeys: Set<string>;
  /** Count of Dependabot-labelled tickets currently in a non-terminal state. Used to cap concurrency. */
  openCount: number;
}

/** Reads/writes the Linear side: the current ticket picture, and creating new ones. */
export interface DependabotTicketStore {
  snapshot(): Promise<DependabotTicketSnapshot>;
  createTicket(alert: DependabotAlert, key: string): Promise<CreatedTicket>;
}

export interface DependabotWatcherOptions {
  config: DependabotConfig;
  tracker: TrackerConfig;
  logger: Logger;
  alertClient?: DependabotAlertClient;
  ticketStore?: DependabotTicketStore;
}

const SEVERITY_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  moderate: 2,
  high: 3,
  critical: 4,
};

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity.toLowerCase()] ?? 1;
}

export function dependabotAlertKey(repoOwner: string, repoName: string, alertNumber: number): string {
  return `${repoOwner}/${repoName}#${alertNumber}`;
}

const MARKER_RE = /<!--\s*symphony-dependabot:(.+?)\s*-->/;

/** Pulls the dedupe key out of a ticket description's hidden marker, if present. */
export function extractAlertKey(description: string): string | null {
  const m = description.match(MARKER_RE);
  return m ? m[1] : null;
}

export function buildDependabotTicketTitle(alert: DependabotAlert): string {
  const summary = truncate(alert.summary || `Vulnerability in ${alert.packageName}`, 120);
  return `[Dependabot] ${alert.severity}: ${alert.packageName} — ${summary}`;
}

export function buildDependabotTicketDescription(alert: DependabotAlert, key: string): string {
  const advisory = [alert.ghsaId, alert.cveId ? `(${alert.cveId})` : null].filter(Boolean).join(" ") || "—";
  const refs = alert.references.slice(0, 5).map(url => `- ${url}`).join("\n") || "_None_";
  const hasPatch = Boolean(alert.firstPatchedVersion);

  const ac = hasPatch
    ? [
        `- [ ] Update \`${alert.packageName}\` to a non-vulnerable version (\`>= ${alert.firstPatchedVersion}\`) wherever it is depended on.`,
        "- [ ] Run `pnpm install` so the lockfile is regenerated, then commit the lockfile change.",
        "- [ ] Run the affected package's typecheck, lint, and tests; fix any breakage the upgrade introduces.",
        `- [ ] If \`${alert.packageName}\` is only a transitive dependency, add a \`pnpm.overrides\` entry (or bump the direct dependent) so the resolved version is patched.`,
        "- [ ] Open a PR. The Dependabot alert auto-closes once the fix lands on the default branch.",
      ]
    : [
        `- [ ] No patched version is published yet for \`${alert.packageName}\`. Assess the real exposure and pick a mitigation: pin to a safe version, apply a workaround, swap the dependency, or dismiss the alert with a documented reason.`,
        "- [ ] If a code change is needed, run `pnpm install`, then the affected package's typecheck, lint, and tests; fix any breakage.",
        "- [ ] Open a PR (or, if dismissing, record the rationale on this ticket).",
      ];

  return [
    `<!-- symphony-dependabot:${key} -->`,
    "> Auto-filed by Symphony from a GitHub Dependabot alert. Resolve the vulnerability, verify nothing breaks, and open a PR.",
    "",
    "## Vulnerability",
    `- **Package:** \`${alert.packageName}\` (${alert.ecosystem})`,
    `- **Severity:** ${alert.severity}`,
    `- **Manifest:** ${alert.manifestPath ? `\`${alert.manifestPath}\`` : "—"}`,
    `- **Vulnerable versions:** ${alert.vulnerableRange ? `\`${alert.vulnerableRange}\`` : "—"}`,
    `- **First patched version:** ${alert.firstPatchedVersion ? `\`${alert.firstPatchedVersion}\`` : "_none published yet_"}`,
    `- **Advisory:** ${advisory}`,
    `- **Alert:** ${alert.htmlUrl}`,
    "",
    "## Summary",
    alert.summary || "_No summary provided._",
    "",
    truncate(alert.description || "", 1500),
    "",
    "## References",
    refs,
    "",
    "## Acceptance criteria",
    ...ac,
  ].join("\n").trim();
}

/**
 * Scans the repo's open Dependabot alerts each tick and files a Linear ticket
 * for the most severe un-ticketed alert — assigned to the configured user, in
 * the configured active state — then leaves the rest to Symphony's normal poll
 * loop, which dispatches an agent to bump the dependency, run `pnpm install`,
 * test, and open a PR.
 *
 * Only `maxOpenTickets` Dependabot tickets (default 1) are ever open at once:
 * the watcher counts Dependabot-labelled tickets in a non-terminal state and
 * files nothing while that cap is reached, so the next alert isn't picked up
 * until the current ticket is Done/Cancelled. This keeps dependency bumps
 * serialized rather than opening a PR per alert simultaneously.
 *
 * Mirrors MergeConflictResolver's shape: a `cycleInFlight` guard, an injectable
 * GitHub client, and dedupe that survives restarts (markers on labelled tickets)
 * backed by an in-process set for the same-run fast path.
 */
export class DependabotWatcher {
  private readonly cfg: DependabotConfig;
  private readonly tracker: TrackerConfig;
  private readonly log: Logger;
  private readonly alertClient: DependabotAlertClient;
  private readonly ticketStore: DependabotTicketStore;
  private readonly createdKeys = new Set<string>();
  private cycleInFlight = false;

  constructor(opts: DependabotWatcherOptions) {
    this.cfg = opts.config;
    this.tracker = opts.tracker;
    this.log = opts.logger;
    this.alertClient = opts.alertClient ?? new GhDependabotAlertClient();
    this.ticketStore = opts.ticketStore ?? new LinearTicketStore(opts.config, opts.tracker, opts.logger);
  }

  async reconcile(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.cycleInFlight) return;

    this.cycleInFlight = true;
    try {
      let alerts: DependabotAlert[];
      try {
        alerts = await this.alertClient.listOpenAlerts(this.cfg);
      } catch (e) {
        this.log.warn(`Dependabot alert poll failed: ${fmtErr(e)}`);
        return;
      }

      const minRank = severityRank(this.cfg.minSeverity);
      const eligible = alerts
        .filter(a => a.state === "open" && severityRank(a.severity) >= minRank)
        // Worst first, so the single open ticket targets the most severe alert.
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.number - b.number);
      if (eligible.length === 0) return;

      // Fail safe: if we can't read the current ticket picture, skip creation this
      // tick rather than risk filing duplicates or breaching the open-ticket cap.
      let snap: DependabotTicketSnapshot;
      try {
        snap = await this.ticketStore.snapshot();
      } catch (e) {
        this.log.warn(`Dependabot ticket snapshot failed, skipping creation this tick: ${fmtErr(e)}`);
        return;
      }

      let openCount = snap.openCount;
      for (const alert of eligible) {
        // Hard cap: never exceed maxOpenTickets Dependabot tickets open at once.
        if (openCount >= this.cfg.maxOpenTickets) break;
        const key = dependabotAlertKey(this.cfg.repoOwner, this.cfg.repoName, alert.number);
        // Already has a ticket (open or already-closed) — never re-file the same alert.
        if (this.createdKeys.has(key) || snap.existingKeys.has(key)) continue;

        try {
          const ticket = await this.ticketStore.createTicket(alert, key);
          this.createdKeys.add(key);
          openCount++;
          this.log.info("Filed Linear ticket for Dependabot alert", {
            alert: key,
            issue: ticket.identifier,
            severity: alert.severity,
            package: alert.packageName,
          });
        } catch (e) {
          this.log.warn(`Failed to file Dependabot ticket for ${key}: ${fmtErr(e)}`, { alert: key });
        }
      }
    } finally {
      this.cycleInFlight = false;
    }
  }

  /** Number of tickets this watcher has filed since the process started. */
  getCreatedCount(): number {
    return this.createdKeys.size;
  }
}

// ─── Default GitHub client (gh api) ─────────────────────────────────────────

interface GhAlertPayload {
  number?: number;
  state?: string;
  html_url?: string;
  dependency?: {
    package?: { ecosystem?: string; name?: string };
    manifest_path?: string;
    scope?: string;
  };
  security_advisory?: {
    ghsa_id?: string;
    cve_id?: string | null;
    summary?: string;
    description?: string;
    severity?: string;
    references?: Array<{ url?: string }>;
  };
  security_vulnerability?: {
    severity?: string;
    vulnerable_version_range?: string;
    first_patched_version?: { identifier?: string } | null;
  };
}

class GhDependabotAlertClient implements DependabotAlertClient {
  async listOpenAlerts(config: DependabotConfig): Promise<DependabotAlert[]> {
    const { stdout } = await execFileP(
      "gh",
      [
        "api",
        "--paginate",
        `repos/${config.repoOwner}/${config.repoName}/dependabot/alerts?state=open&per_page=100`,
      ],
      { env: process.env, encoding: "utf8", timeout: config.requestTimeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );

    const payload = JSON.parse(stdout) as GhAlertPayload[];
    if (!Array.isArray(payload)) return [];

    return payload
      .filter(a => typeof a.number === "number")
      .map(normalizeAlert);
  }
}

function normalizeAlert(a: GhAlertPayload): DependabotAlert {
  const adv = a.security_advisory ?? {};
  const vuln = a.security_vulnerability ?? {};
  const pkg = a.dependency?.package ?? {};
  return {
    number: a.number as number,
    state: a.state ?? "open",
    ecosystem: pkg.ecosystem ?? "unknown",
    packageName: pkg.name ?? "unknown",
    manifestPath: a.dependency?.manifest_path ?? null,
    scope: a.dependency?.scope ?? null,
    severity: (adv.severity ?? vuln.severity ?? "unknown").toLowerCase(),
    summary: adv.summary ?? "",
    description: adv.description ?? "",
    ghsaId: adv.ghsa_id ?? null,
    cveId: adv.cve_id ?? null,
    vulnerableRange: vuln.vulnerable_version_range ?? null,
    firstPatchedVersion: vuln.first_patched_version?.identifier ?? null,
    references: (adv.references ?? []).map(r => r.url).filter((u): u is string => typeof u === "string"),
    htmlUrl: a.html_url ?? "",
  };
}

// ─── Default Linear ticket store ────────────────────────────────────────────

interface ResolvedRefs {
  teamId: string;
  stateId: string;
  assigneeId: string | null;
  labelId: string | null;
}

class LinearTicketStore implements DependabotTicketStore {
  private refs: ResolvedRefs | null = null;
  private readonly terminalStatesLower: Set<string>;

  constructor(
    private readonly cfg: DependabotConfig,
    private readonly tracker: TrackerConfig,
    private readonly log: Logger,
  ) {
    this.terminalStatesLower = new Set(tracker.terminalStates.map(s => s.toLowerCase()));
  }

  async snapshot(): Promise<DependabotTicketSnapshot> {
    const issues = await linear.fetchIssuesByLabel(this.tracker, this.cfg.teamKey, this.cfg.label);
    const existingKeys = new Set<string>();
    let openCount = 0;
    for (const issue of issues) {
      const key = extractAlertKey(issue.description);
      if (key) existingKeys.add(key);
      if (!this.terminalStatesLower.has(issue.state.toLowerCase())) openCount++;
    }
    return { existingKeys, openCount };
  }

  async createTicket(alert: DependabotAlert, key: string): Promise<CreatedTicket> {
    const refs = await this.ensureRefs();
    const issue = await linear.createIssue(this.tracker, {
      teamId: refs.teamId,
      stateId: refs.stateId,
      assigneeId: refs.assigneeId ?? undefined,
      labelIds: refs.labelId ? [refs.labelId] : undefined,
      title: buildDependabotTicketTitle(alert),
      description: buildDependabotTicketDescription(alert, key),
    });
    return { identifier: issue.identifier, url: issue.url };
  }

  /** Resolve team / state / assignee / label IDs once and cache them for the watcher's lifetime. */
  private async ensureRefs(): Promise<ResolvedRefs> {
    if (this.refs) return this.refs;

    const team = await linear.fetchTeamByKey(this.tracker, this.cfg.teamKey);
    if (!team) throw new Error(`Linear team not found for key "${this.cfg.teamKey}"`);

    const states = await linear.fetchWorkflowStates(this.tracker, team.id);
    const state = states.find(s => s.name.toLowerCase() === this.cfg.targetState.toLowerCase());
    if (!state) {
      throw new Error(`Linear workflow state "${this.cfg.targetState}" not found in team "${this.cfg.teamKey}"`);
    }

    let assigneeId: string | null = null;
    if (this.cfg.assigneeEmail) {
      const user = await linear.fetchUserByEmailOrName(this.tracker, this.cfg.assigneeEmail);
      if (user) {
        assigneeId = user.id;
      } else {
        this.log.warn(`Dependabot assignee "${this.cfg.assigneeEmail}" not found in Linear; filing tickets unassigned`);
      }
    }

    let labelId: string | null = null;
    if (this.cfg.label) {
      labelId = await linear.resolveOrCreateLabelId(this.tracker, team.id, this.cfg.label);
    }

    this.refs = { teamId: team.id, stateId: state.id, assigneeId, labelId };
    return this.refs;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function fmtErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
