import { describe, expect, it } from "vitest";
import { classifyDiff, type Risk } from "../diff-risk.js";

describe("classifyDiff — risk", () => {
  it.each<[string, string[], Risk, string]>([
    // high
    ["firestore rules", ["firestore.rules"], "high", "firestore.rules"],
    ["storage rules", ["storage.rules"], "high", "storage.rules"],
    ["indexes", ["firestore.indexes.json"], "high", "indexes"],
    ["auth server module", ["packages/app/app/auth.server.ts"], "high", "auth"],
    ["session util", ["packages/app/app/utils/session.server.ts"], "high", "auth"],
    ["camelCase auth hook", ["packages/app/app/hooks/useAuth.ts"], "high", "auth"],
    ["permissions dir", ["packages/app/app/lib/permissions/index.ts"], "high", "auth"],
    ["roles", ["packages/functions/src/roles.ts"], "high", "auth"],
    ["stripe", ["packages/functions/src/stripe/webhook.ts"], "high", "payments"],
    ["checkout route", ["packages/app/app/routes/checkout.tsx"], "high", "payments"],
    ["billing", ["packages/app/app/components/BillingPanel.tsx"], "high", "payments"],
    ["migration", ["packages/functions/src/migrations/2026-11-add-field.ts"], "high", "migrations"],
    ["schema", ["packages/app/app/models/schema.ts"], "high", "schema"],
    ["function trigger", ["packages/functions/src/users/triggers/onCreate.ts"], "high", "triggers"],
    ["scheduled function", ["packages/functions/src/scheduled/nightly.ts"], "high", "scheduled"],
    ["env file", [".env.production"], "high", "env"],
    ["nested env file", ["packages/app/.env.example"], "high", "env"],
    ["firebase.json", ["firebase.json"], "high", "deploy config"],
    ["render.yaml", ["render.yaml"], "high", "deploy config"],
    ["root config", ["vitest.config.ts"], "high", "root build config"],
    ["workflow", [".github/workflows/ci.yml"], "high", "workflow"],
    ["package.json", ["packages/app/package.json", "pnpm-lock.yaml"], "high", "package.json"],
    // low
    ["unit test", ["packages/app/app/utils/date.test.ts"], "low", "tests"],
    ["auth test is still only a test", ["packages/app/app/__tests__/auth.test.ts"], "low", "tests"],
    ["spec", ["packages/functions/src/foo.spec.ts"], "low", "tests"],
    ["functional tests", ["packages/functional-tests/tests/login.ts"], "low", "tests"],
    ["docs", ["docs/RUNBOOK.md", "README.md"], "low", "docs"],
    ["i18n", ["packages/app/app/locales/en.json"], "low", "copy"],
    ["design export", ["design/TEA-123.html"], "low", "design export"],
    ["lockfile only", ["pnpm-lock.yaml"], "low", "lockfile"],
    // medium
    ["app component", ["packages/app/app/components/Card.tsx"], "medium", "app code"],
    ["functions code", ["packages/functions/src/utils/format.ts"], "medium", "Cloud Functions"],
    ["nested config is not root config", ["packages/app/vite.config.ts"], "medium", "app code"],
    ["Author is not auth", ["packages/app/app/components/Author.tsx"], "medium", "app code"],
    ["no files", [], "medium", "can't classify"],
  ])("%s → %s", (_label, files, risk, reasonFragment) => {
    const out = classifyDiff(files);
    expect(out.risk).toBe(risk);
    expect(out.reasons.join(" | ")).toContain(reasonFragment);
  });

  it("highest file wins", () => {
    expect(classifyDiff(["README.md", "packages/app/app/routes/x.tsx", "firestore.rules"]).risk).toBe("high");
  });
});

describe("classifyDiff — size bump", () => {
  it.each<[string, string[], { additions: number; deletions: number } | undefined, Risk]>([
    ["low + many lines → medium", ["docs/a.md"], { additions: 300, deletions: 101 }, "medium"],
    ["low at the limit stays low", ["docs/a.md"], { additions: 200, deletions: 200 }, "low"],
    ["medium + many lines → high", ["packages/app/app/routes/x.tsx"], { additions: 500, deletions: 0 }, "high"],
    ["medium + many files → high",
      Array.from({ length: 16 }, (_, i) => `packages/app/app/components/C${i}.tsx`), undefined, "high"],
    ["15 files is not many", Array.from({ length: 15 }, (_, i) => `docs/d${i}.md`), undefined, "low"],
    ["high stays high", ["firestore.rules"], { additions: 1000, deletions: 0 }, "high"],
    ["lockfile-only is exempt", ["pnpm-lock.yaml"], { additions: 5000, deletions: 4000 }, "low"],
  ])("%s", (_label, files, stats, risk) => {
    const out = classifyDiff(files, stats);
    expect(out.risk).toBe(risk);
  });

  it("explains the bump", () => {
    const out = classifyDiff(["docs/a.md"], { additions: 450, deletions: 0 });
    expect(out.reasons.some(r => r.includes("450 lines") && r.includes("low → medium"))).toBe(true);
  });
});

describe("classifyDiff — ui", () => {
  it.each<[string, string[], boolean]>([
    ["route", ["packages/app/app/routes/dashboard.tsx"], true],
    ["app ts under app/app", ["packages/app/app/utils/format.ts"], true],
    ["css anywhere", ["packages/app/styles/tailwind.css"], true],
    ["tsx anywhere", ["packages/functions/src/emails/Welcome.tsx"], true],
    ["app test excluded", ["packages/app/app/routes/dashboard.test.tsx"], false],
    ["functional tests excluded", ["packages/functional-tests/tests/a.tsx"], false],
    ["functions ts", ["packages/functions/src/index.ts"], false],
    ["docs", ["README.md"], false],
  ])("%s → %s", (_label, files, ui) => {
    expect(classifyDiff(files).ui).toBe(ui);
  });
});
