import { executeGraphQL, fetchUserByEmailOrName, resolveOrCreateLabelId, type LinearComment } from "./linear.js";
import type { TrackerConfig } from "./types.js";

/**
 * Small Linear mutations the v2 flows need: move state, add/remove a label,
 * (re)assign, and read an issue with its team context. Thin wrappers over
 * `executeGraphQL` so callers stay readable and tests can mock this module.
 */

export interface IssueContext {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  priority: number | null;
  state: string;
  teamId: string;
  states: Array<{ id: string; name: string }>;
  labels: Array<{ id: string; name: string }>;
  assigneeId: string | null;
}

const ISSUE_CONTEXT_QUERY = `
  query IssueContext($id: String!) {
    issue(id: $id) {
      id identifier title url description priority
      state { name }
      assignee { id }
      labels { nodes { id name } }
      team { id states { nodes { id name } } }
    }
  }
`;

interface IssueContextPayload {
  issue: {
    id: string; identifier: string; title: string; url: string; description: string | null; priority: number | null;
    state: { name: string } | null;
    assignee: { id: string } | null;
    labels: { nodes: Array<{ id: string; name: string }> };
    team: { id: string; states: { nodes: Array<{ id: string; name: string }> } };
  } | null;
}

export async function getIssueContext(tracker: TrackerConfig, issueId: string): Promise<IssueContext | null> {
  const data = (await executeGraphQL(tracker, ISSUE_CONTEXT_QUERY, { id: issueId })) as IssueContextPayload;
  const i = data.issue;
  if (!i) return null;
  return {
    id: i.id, identifier: i.identifier, title: i.title, url: i.url, description: i.description, priority: i.priority,
    state: i.state?.name ?? "",
    teamId: i.team.id,
    states: i.team.states.nodes,
    labels: i.labels.nodes,
    assigneeId: i.assignee?.id ?? null,
  };
}

const ISSUE_UPDATE = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success }
  }
`;

async function update(tracker: TrackerConfig, id: string, input: Record<string, unknown>): Promise<void> {
  const data = (await executeGraphQL(tracker, ISSUE_UPDATE, { id, input })) as { issueUpdate?: { success: boolean } };
  if (!data.issueUpdate?.success) throw new Error(`issueUpdate failed for ${id}`);
}

export async function setIssueState(tracker: TrackerConfig, issueId: string, stateName: string): Promise<boolean> {
  const ctx = await getIssueContext(tracker, issueId);
  if (!ctx) return false;
  const state = ctx.states.find(s => s.name.toLowerCase() === stateName.toLowerCase());
  if (!state) throw new Error(`No Linear state named "${stateName}"`);
  if (ctx.state.toLowerCase() === stateName.toLowerCase()) return false;
  await update(tracker, issueId, { stateId: state.id });
  return true;
}

export async function addIssueLabel(tracker: TrackerConfig, issueId: string, name: string): Promise<void> {
  const ctx = await getIssueContext(tracker, issueId);
  if (!ctx || ctx.labels.some(l => l.name.toLowerCase() === name.toLowerCase())) return;
  const labelId = await resolveOrCreateLabelId(tracker, ctx.teamId, name);
  await update(tracker, issueId, { labelIds: [...ctx.labels.map(l => l.id), labelId] });
}

export async function removeIssueLabel(tracker: TrackerConfig, issueId: string, name: string): Promise<void> {
  const ctx = await getIssueContext(tracker, issueId);
  if (!ctx) return;
  const keep = ctx.labels.filter(l => l.name.toLowerCase() !== name.toLowerCase());
  if (keep.length === ctx.labels.length) return;
  await update(tracker, issueId, { labelIds: keep.map(l => l.id) });
}

export async function setIssueAssignee(tracker: TrackerConfig, issueId: string, userId: string | null): Promise<void> {
  await update(tracker, issueId, { assigneeId: userId });
}

const userIdCache = new Map<string, string | null>();

/** Linear user id for an email or display name (cached). */
export async function resolveUserId(tracker: TrackerConfig, emailOrName: string): Promise<string | null> {
  if (userIdCache.has(emailOrName)) return userIdCache.get(emailOrName)!;
  const user = await fetchUserByEmailOrName(tracker, emailOrName);
  userIdCache.set(emailOrName, user?.id ?? null);
  return user?.id ?? null;
}

const ISSUES_WITH_LABEL_PREFIX = `
  query WaitingIssues($teamKey: String!, $prefix: String!) {
    issues(first: 100, filter: {
      team: { key: { eq: $teamKey } },
      labels: { name: { startsWith: $prefix } },
      state: { type: { nin: ["completed", "canceled"] } }
    }) {
      nodes { id identifier title url description labels { nodes { name } } }
    }
  }
`;

export interface LabeledIssueLite {
  id: string; identifier: string; title: string; url: string; description: string | null; labels: string[];
}

/** Open issues in the team with any label starting with `prefix` (e.g. "waiting-on:"). */
export async function fetchIssuesWithLabelPrefix(tracker: TrackerConfig, teamKey: string, prefix: string): Promise<LabeledIssueLite[]> {
  const data = (await executeGraphQL(tracker, ISSUES_WITH_LABEL_PREFIX, { teamKey, prefix })) as {
    issues: { nodes: Array<{ id: string; identifier: string; title: string; url: string; description: string | null; labels: { nodes: Array<{ name: string }> } }> };
  };
  return data.issues.nodes.map(n => ({ ...n, labels: n.labels.nodes.map(l => l.name) }));
}

const ISSUES_IN_STATE = `
  query IssuesInState($teamKey: String!, $state: String!) {
    issues(first: 100, filter: { team: { key: { eq: $teamKey } }, state: { name: { eqIgnoreCase: $state } } }) {
      nodes { id identifier title url description priority labels { nodes { name } } }
    }
  }
`;

export interface StateIssue extends LabeledIssueLite { priority: number | null }

export async function fetchIssuesInState(tracker: TrackerConfig, teamKey: string, state: string): Promise<StateIssue[]> {
  const data = (await executeGraphQL(tracker, ISSUES_IN_STATE, { teamKey, state })) as {
    issues: { nodes: Array<{ id: string; identifier: string; title: string; url: string; description: string | null; priority: number | null; labels: { nodes: Array<{ name: string }> } }> };
  };
  return data.issues.nodes.map(n => ({ ...n, labels: n.labels.nodes.map(l => l.name) }));
}

/** Latest comment body containing `marker`, newest first. */
export function latestWithMarker(comments: LinearComment[], marker: string): LinearComment | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].body.includes(marker)) return comments[i];
  }
  return null;
}
