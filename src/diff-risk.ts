/**
 * Post-build routing (ORCHESTRATOR_REDESIGN §6, point 2): risk from what the
 * diff actually touched. Deterministic path rules — no model call.
 *
 * Paths are repo-relative, as `gh pr view --json files` returns them, for the
 * team-dsc monorepo (packages/app, packages/functions, packages/functional-tests).
 */

export type Risk = "low" | "medium" | "high";

export interface DiffRisk {
  risk: Risk;
  ui: boolean;
  reasons: string[];
}

const SIZE_LINES_LIMIT = 400;
const SIZE_FILES_LIMIT = 15;

const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "npm-shrinkwrap.json", "bun.lockb"]);

/** High-risk path rules, checked in order; the first match names the reason. */
const HIGH_RULES: Array<{ reason: string; test: (p: string, base: string) => boolean }> = [
  { reason: "touches firestore.rules", test: (_p, b) => b === "firestore.rules" },
  { reason: "touches storage.rules", test: (_p, b) => b === "storage.rules" },
  { reason: "touches Firestore indexes", test: (_p, b) => b.endsWith(".indexes.json") || b === "firestore.indexes.json" },
  { reason: "touches a CI workflow", test: p => p.startsWith(".github/workflows/") },
  { reason: "touches env files", test: (_p, b) => b.startsWith(".env") },
  { reason: "touches deploy config", test: (_p, b) => b === "firebase.json" || b === ".firebaserc" || b === "render.yaml" },
  { reason: "touches root build config", test: p => !p.includes("/") && /\.config\.[a-z0-9]+$/i.test(p) },
  { reason: "changes dependencies (package.json)", test: (_p, b) => b === "package.json" },
  {
    reason: "touches Cloud Function triggers",
    test: p => p.startsWith("packages/functions/src/") && /\/triggers\//.test(p),
  },
  {
    reason: "touches scheduled Cloud Functions",
    test: p => p.startsWith("packages/functions/src/") && /\/scheduled\//.test(p),
  },
  { reason: "touches DB migrations or schema", test: p => isMigrationOrSchema(p) },
  { reason: "touches payments code", test: p => /payment|stripe|billing|checkout/i.test(p) },
  { reason: "touches auth/session/permissions code", test: p => isAuthPath(p) },
];

function isMigrationOrSchema(p: string): boolean {
  return /(^|[\/._-])(migrations?|schemas?)([\/._-]|$)/i.test(p) || /\.sql$/i.test(p) || /\.prisma$/i.test(p);
}

function isAuthPath(p: string): boolean {
  // Separator-bounded words (auth.server.ts, routes/login.tsx, lib/permissions/…)…
  if (/(^|[\/._-])(auth|oauth|authn|authz|authentication|authorization|authorisation|session|sessions|permission|permissions|role|roles|rbac|login|signin|sign-in|logout)([\/._-]|$)/i.test(p)) {
    return true;
  }
  // …and camelCase (useAuth.ts, AuthProvider.tsx, requireRole.ts). "Author" is not "Auth".
  return /(^|[a-z\/])(Auth|Session|Permissions?|Roles?)(?=[A-Z._\/-]|$)/.test(p);
}

function isTest(p: string): boolean {
  return /\.(test|spec)\.[a-z0-9]+$/i.test(p) ||
    /(^|\/)__tests__\//.test(p) ||
    p.startsWith("packages/functional-tests/");
}

function isLockfile(base: string): boolean {
  return LOCKFILES.has(base);
}

function isDocs(p: string, base: string): boolean {
  return /\.(md|mdx|txt)$/i.test(base) || p.startsWith("docs/") || /(^|\/)docs\//.test(p);
}

function isCopyJson(p: string): boolean {
  return /\.json$/i.test(p) && /(^|\/)(locales?|i18n|lang|langs|translations?|copy)(\/|\.json$)/i.test(p);
}

function isDesign(p: string): boolean {
  return p.startsWith("design/");
}

function isUi(p: string): boolean {
  if (isTest(p)) return false;
  return p.startsWith("packages/app/app/") || /\.(css|tsx)$/i.test(p);
}

function normalise(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const BUMP: Record<Risk, Risk> = { low: "medium", medium: "high", high: "high" };

export function classifyDiff(files: string[], stats?: { additions: number; deletions: number }): DiffRisk {
  const paths = files.map(normalise).filter(Boolean);
  if (paths.length === 0) {
    return { risk: "medium", ui: false, reasons: ["no changed files listed — can't classify, treating as medium"] };
  }

  const reasons: string[] = [];
  const addReason = (r: string) => { if (!reasons.includes(r)) reasons.push(r); };
  let risk: Risk = "low";
  const raise = (r: Risk) => { if (RANK[r] > RANK[risk]) risk = r; };

  let ui = false;
  const lowKinds = new Set<string>();
  const mediumExamples: string[] = [];
  let mediumCount = 0;
  let functionsCode = false;

  for (const p of paths) {
    const base = p.split("/").pop() ?? p;
    if (isUi(p)) ui = true;

    // Tests, docs, copy, design exports and lockfiles are low regardless of
    // where they live (an auth.test.ts is still only a test).
    if (isTest(p)) { lowKinds.add("tests"); continue; }
    if (isLockfile(base)) { lowKinds.add("lockfile"); continue; }
    if (isDesign(p)) { lowKinds.add("design export"); continue; }
    if (isDocs(p, base)) { lowKinds.add("docs"); continue; }
    if (isCopyJson(p)) { lowKinds.add("copy"); continue; }

    const high = HIGH_RULES.find(rule => rule.test(p, base));
    if (high) {
      raise("high");
      addReason(`${high.reason} (${p})`);
      continue;
    }

    raise("medium");
    if (p.startsWith("packages/functions/")) { functionsCode = true; continue; }
    mediumCount++;
    if (mediumExamples.length < 3) mediumExamples.push(p);
  }

  if (functionsCode) addReason("changes Cloud Functions code");
  if (mediumExamples.length > 0 && (risk as Risk) === "medium") {
    addReason(`changes app code (${mediumExamples.join(", ")}${mediumCount > mediumExamples.length ? ", …" : ""})`);
  }
  if (risk === "low") {
    addReason(`only ${[...lowKinds].sort().join(" / ")} changed`);
  }

  // Size bump — skipped for lockfile-only diffs (lockfile churn is huge but inert).
  const lockfileOnly = lowKinds.size === 1 && lowKinds.has("lockfile");
  if (!lockfileOnly) {
    const lines = stats ? stats.additions + stats.deletions : 0;
    const bigLines = lines > SIZE_LINES_LIMIT;
    const bigFiles = paths.length > SIZE_FILES_LIMIT;
    if (bigLines || bigFiles) {
      const before: Risk = risk;
      risk = BUMP[risk];
      const why = [bigLines ? `${lines} lines changed` : null, bigFiles ? `${paths.length} files changed` : null]
        .filter(Boolean).join(", ");
      addReason(before === risk ? `large diff (${why})` : `large diff (${why}) — raised ${before} → ${risk}`);
    }
  }

  return { risk, ui, reasons };
}
