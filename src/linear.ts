import type { Issue, BlockerRef, IssuePerson, TrackerConfig } from "./types.js";

export type LinearErrorCode =
  | "linear_api_request"
  | "linear_api_status"
  | "linear_graphql_errors"
  | "linear_unknown_payload"
  | "linear_missing_end_cursor"
  | "linear_invalid_response";

export class LinearError extends Error {
  readonly code: LinearErrorCode;
  readonly status?: number;
  readonly graphqlErrors?: Array<{ message: string }>;
  constructor(
    code: LinearErrorCode,
    message: string,
    extra?: { status?: number; graphqlErrors?: Array<{ message: string }> },
  ) {
    super(message);
    this.name = "LinearError";
    this.code = code;
    if (extra?.status !== undefined) this.status = extra.status;
    if (extra?.graphqlErrors !== undefined) this.graphqlErrors = extra.graphqlErrors;
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function graphql<T>(
  endpoint: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new LinearError("linear_api_request", e instanceof Error ? e.message : String(e));
  }

  if (!response.ok) {
    let body = "";
    try { body = await response.text(); } catch { /* ignore */ }
    throw new LinearError(
      "linear_api_status",
      `Linear API returned HTTP ${response.status}: ${body.slice(0, 300)}`,
      { status: response.status },
    );
  }

  const json = (await response.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    const msg = json.errors.map(e => e.message).join("; ");
    throw new LinearError("linear_graphql_errors", `GraphQL errors: ${msg}`, { graphqlErrors: json.errors });
  }
  if (!json.data) {
    throw new LinearError("linear_unknown_payload", "Linear response had neither data nor errors");
  }
  return json.data;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new LinearError(
      "linear_invalid_response",
      `Expected issue.${field} to be string, got ${value === null ? "null" : typeof value}`,
    );
  }
  return value;
}

function normalizePerson(value: unknown): IssuePerson | null {
  if (!value || typeof value !== "object") return null;
  const person = value as Record<string, unknown>;
  if (typeof person.name !== "string" || !person.name.trim()) return null;
  return {
    name: person.name,
    email: typeof person.email === "string" && person.email.trim() ? person.email : null,
  };
}

function normalizeIssue(node: Record<string, unknown>): Issue {
  const labelsData = node.labels as { nodes: Array<{ name: string }> } | null;
  const labels = (labelsData?.nodes ?? []).map(l => l.name.toLowerCase());

  const inverseRels = node.inverseRelations as { nodes: Array<{ type: string; issue: Record<string, unknown> | null }> } | null;
  const blockedBy: BlockerRef[] = (inverseRels?.nodes ?? [])
    .filter(r => r.type === "blocks")
    .map(r => {
      if (!r.issue) return null;
      const st = r.issue.state as { name: string } | null;
      return {
        id: (r.issue.id as string | null) ?? null,
        identifier: (r.issue.identifier as string | null) ?? null,
        state: st?.name ?? null,
      };
    })
    .filter((b): b is BlockerRef => b !== null);

  const priority = node.priority;
  const state = node.state as { name: string } | null;

  return {
    id: expectString(node.id, "id"),
    identifier: expectString(node.identifier, "identifier"),
    title: expectString(node.title, "title"),
    description: (node.description as string | null) ?? null,
    priority: typeof priority === "number" ? priority : null,
    state: state?.name ?? "",
    branchName: (node.branchName as string | null) ?? null,
    url: (node.url as string | null) ?? null,
    labels,
    blockedBy,
    assignee: normalizePerson(node.assignee),
    creator: normalizePerson(node.creator),
    createdAt: node.createdAt ? new Date(node.createdAt as string) : null,
    updatedAt: node.updatedAt ? new Date(node.updatedAt as string) : null,
  };
}

const CANDIDATE_QUERY_PROJECT = `
  query CandidateIssuesByProject($projectSlug: String!, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: $first
      after: $after
    ) {
      nodes {
        id identifier title description priority
        state { name }
        assignee { name email }
        creator { name email }
        branchName url
        labels { nodes { name } }
        inverseRelations {
          nodes {
            type
            issue { id identifier state { name } }
          }
        }
        createdAt updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CANDIDATE_QUERY_TEAM = `
  query CandidateIssuesByTeam($teamKey: String!, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      filter: {
        team: { key: { eq: $teamKey } }
        state: { name: { in: $states } }
      }
      first: $first
      after: $after
    ) {
      nodes {
        id identifier title description priority
        state { name }
        assignee { name email }
        creator { name email }
        branchName url
        labels { nodes { name } }
        inverseRelations {
          nodes {
            type
            issue { id identifier state { name } }
          }
        }
        createdAt updatedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface IssuesPage {
  issues: {
    nodes: Record<string, unknown>[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function fetchCandidateIssues(config: TrackerConfig): Promise<Issue[]> {
  const useTeam = config.projectSlug === "ALL";
  const query = useTeam ? CANDIDATE_QUERY_TEAM : CANDIDATE_QUERY_PROJECT;
  const baseVars = useTeam
    ? { teamKey: config.teamKey }
    : { projectSlug: config.projectSlug };

  const issues: Issue[] = [];
  let after: string | null = null;

  while (true) {
    const vars: Record<string, unknown> = { ...baseVars, states: config.activeStates, first: 50 };
    if (after !== null) vars.after = after;
    const data: IssuesPage = await graphql<IssuesPage>(
      config.endpoint,
      config.apiKey,
      query,
      vars
    );

    for (const node of data.issues.nodes) {
      issues.push(normalizeIssue(node));
    }

    if (!data.issues.pageInfo.hasNextPage) break;
    if (!data.issues.pageInfo.endCursor) {
      throw new LinearError("linear_missing_end_cursor", "Linear pagination returned hasNextPage with no cursor");
    }
    after = data.issues.pageInfo.endCursor;
  }

  return issues;
}

const ISSUES_BY_STATES_QUERY_PROJECT = `
  query IssuesByStatesProject($projectSlug: String!, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: $first
      after: $after
    ) {
      nodes { id identifier }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUES_BY_STATES_QUERY_TEAM = `
  query IssuesByStatesTeam($teamKey: String!, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      filter: {
        team: { key: { eq: $teamKey } }
        state: { name: { in: $states } }
      }
      first: $first
      after: $after
    ) {
      nodes { id identifier }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface MinimalIssuesPage {
  issues: {
    nodes: Array<{ id: string; identifier: string }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function fetchIssuesByStates(
  config: TrackerConfig,
  states: string[]
): Promise<Array<{ id: string; identifier: string }>> {
  if (states.length === 0) return [];

  const useTeam = config.projectSlug === "ALL";
  const query = useTeam ? ISSUES_BY_STATES_QUERY_TEAM : ISSUES_BY_STATES_QUERY_PROJECT;
  const baseVars = useTeam
    ? { teamKey: config.teamKey }
    : { projectSlug: config.projectSlug };

  const results: Array<{ id: string; identifier: string }> = [];
  let after: string | null = null;

  while (true) {
    const vars: Record<string, unknown> = { ...baseVars, states, first: 50 };
    if (after !== null) vars.after = after;
    const data: MinimalIssuesPage = await graphql<MinimalIssuesPage>(
      config.endpoint,
      config.apiKey,
      query,
      vars
    );
    results.push(...data.issues.nodes);

    if (!data.issues.pageInfo.hasNextPage) break;
    if (!data.issues.pageInfo.endCursor) break;
    after = data.issues.pageInfo.endCursor;
  }

  return results;
}

const ISSUE_STATES_BY_IDS_QUERY = `
  query IssueStatesByIds($ids: [ID!]!) {
    issues(filter: { id: { in: $ids } }) {
      nodes { id identifier state { name } }
    }
  }
`;

interface IssueStatesPage {
  issues: {
    nodes: Array<{ id: string; identifier: string; state: { name: string } }>;
  };
}

export async function fetchIssueStatesByIds(
  config: TrackerConfig,
  ids: string[]
): Promise<Array<{ id: string; identifier: string; state: string }>> {
  if (ids.length === 0) return [];

  const data: IssueStatesPage = await graphql<IssueStatesPage>(
    config.endpoint,
    config.apiKey,
    ISSUE_STATES_BY_IDS_QUERY,
    { ids }
  );

  return data.issues.nodes.map(n => ({
    id: n.id,
    identifier: n.identifier,
    state: n.state.name,
  }));
}

const ORG_URL_KEY_QUERY = `
  query Organization { organization { urlKey } }
`;

interface OrgPayload {
  organization: { urlKey: string };
}

/**
 * Best-effort lookup of the Linear team URL — `https://linear.app/<orgKey>/team/<teamKey>`.
 * Returns null on any failure; callers should treat the URL as optional UI sugar.
 */
export async function fetchTeamUrl(config: TrackerConfig): Promise<string | null> {
  if (!config.teamKey) return null;
  try {
    const data = await graphql<OrgPayload>(config.endpoint, config.apiKey, ORG_URL_KEY_QUERY);
    const orgKey = data.organization?.urlKey;
    if (!orgKey) return null;
    return `https://linear.app/${orgKey}/team/${config.teamKey}/all`;
  } catch {
    return null;
  }
}

export async function executeGraphQL(
  config: TrackerConfig,
  query: string,
  variables?: Record<string, unknown>
): Promise<unknown> {
  return graphql<unknown>(config.endpoint, config.apiKey, query, variables);
}
