import { describe, expect, it } from "vitest";
import { routeTicket } from "../routing.js";

const CLEAR =
  "When a coach opens the roster the attendance count is off by one for athletes added today. " +
  "Expected the count to include them. Seen on prod since Tuesday's deploy.";
const STEPS = "1. Open roster\n2. Add athlete\n3. Count is wrong";

type Case = {
  name: string;
  title?: string;
  description?: string | null;
  labels?: string[];
  plan: boolean;
  ui: boolean;
  lenses: string[];
};

describe("routeTicket", () => {
  it.each<Case>([
    // plan via labels
    { name: "Feature label", labels: ["Feature"], description: CLEAR, plan: true, ui: false, lenses: [] },
    { name: "Improvement label (lower-case)", labels: ["improvement"], description: CLEAR, plan: true, ui: false, lenses: [] },
    { name: "TechDebt label", labels: ["TechDebt"], description: CLEAR, plan: true, ui: false, lenses: [] },
    { name: "Tech Debt spaced", labels: ["Tech Debt"], description: CLEAR, plan: true, ui: false, lenses: [] },
    {
      name: "Design needed → plan + ui", labels: ["Design needed"], description: CLEAR,
      plan: true, ui: true, lenses: ["ACCESSIBILITY", "MOBILE_UX"],
    },
    // plan via text
    { name: "thin description", description: "fix it", plan: true, ui: false, lenses: [] },
    { name: "null description", description: null, plan: true, ui: false, lenses: [] },
    { name: "short but has steps", description: STEPS, plan: false, ui: false, lenses: [] },
    { name: "migration keyword", description: `${CLEAR} Needs a data migration.`, plan: true, ui: false, lenses: [] },
    { name: "schema keyword", title: "Update user schema", description: CLEAR, plan: true, ui: false, lenses: [] },
    { name: "refactor keyword", title: "Refactor roster service", description: CLEAR, plan: true, ui: false, lenses: [] },
    { name: "new collection", description: `${CLEAR} Add a new collection for invites.`, plan: true, ui: false, lenses: [] },
    {
      name: "Claude Design link", description: `${CLEAR} https://claude.ai/design/abc123`,
      plan: true, ui: true, lenses: ["ACCESSIBILITY", "MOBILE_UX"],
    },
    {
      name: "Figma link", description: `${CLEAR} https://www.figma.com/design/KEY/Name`,
      plan: true, ui: true, lenses: ["ACCESSIBILITY", "MOBILE_UX"],
    },
    // no plan
    { name: "Bug with clear description", labels: ["Bug"], description: CLEAR, plan: false, ui: false, lenses: [] },
    { name: "Bug with thin description", labels: ["Bug"], description: "broken", plan: true, ui: false, lenses: [] },
    { name: "Bug mentioning migration still plans", labels: ["Bug"], description: `${CLEAR} Requires migration.`, plan: true, ui: false, lenses: [] },
    { name: "dependabot", labels: ["dependabot"], description: `${CLEAR} Bumps json-schema.`, plan: false, ui: false, lenses: [] },
    { name: "firebase-logs (case-insensitive)", labels: ["Firebase-Logs"], description: CLEAR, plan: false, ui: false, lenses: [] },
    { name: "posthog", labels: ["posthog"], description: CLEAR, plan: false, ui: false, lenses: [] },
    { name: "posthog but thin → plan", labels: ["posthog"], description: "error", plan: true, ui: false, lenses: [] },
    { name: "Feature beats Bug", labels: ["Bug", "Feature"], description: CLEAR, plan: true, ui: false, lenses: [] },
    // ui words + lenses
    {
      name: "button word", title: "Save button misaligned", labels: ["Bug"], description: CLEAR,
      plan: false, ui: true, lenses: ["ACCESSIBILITY", "MOBILE_UX"],
    },
    {
      name: "mobile word", title: "Roster on mobile", labels: ["Bug"], description: CLEAR,
      plan: false, ui: true, lenses: ["ACCESSIBILITY", "MOBILE_UX"],
    },
    {
      name: "UI word", title: "UI glitch in roster", labels: ["Bug"], description: CLEAR,
      plan: false, ui: true, lenses: ["ACCESSIBILITY", "MOBILE_UX"],
    },
    {
      name: "ux-insights label is ui", labels: ["ux-insights"], description: CLEAR,
      plan: false, ui: true, lenses: ["ACCESSIBILITY", "MOBILE_UX"],
    },
    { name: "query-insights → performance", labels: ["query-insights"], description: CLEAR, plan: false, ui: false, lenses: ["PERFORMANCE"] },
    { name: "slow → performance", title: "Roster is slow", labels: ["Bug"], description: CLEAR, plan: false, ui: false, lenses: ["PERFORMANCE"] },
    { name: "wording → clear writing", title: "Fix wording on invite email", labels: ["Bug"], description: CLEAR, plan: false, ui: false, lenses: ["CLEAR_WRITING"] },
    {
      name: "all lenses, canonical order", title: "Slow page with confusing copy", labels: ["Bug"], description: CLEAR,
      plan: false, ui: true, lenses: ["PERFORMANCE", "ACCESSIBILITY", "MOBILE_UX", "CLEAR_WRITING"],
    },
  ])("$name", c => {
    const route = routeTicket({
      title: c.title ?? "Attendance count wrong",
      description: c.description === undefined ? CLEAR : c.description,
      labels: c.labels ?? [],
      priority: null,
    });
    expect({ plan: route.plan, ui: route.ui, lenses: route.lenses }).toEqual({ plan: c.plan, ui: c.ui, lenses: c.lenses });
    expect(route.reasons.length).toBeGreaterThan(0);
  });
});
