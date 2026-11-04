import { describe, expect, it } from "vitest";
import { designExportPath, extractDesignLinks } from "../design-links.js";

describe("extractDesignLinks", () => {
  it("finds Claude Design and Figma links in markdown and prose, in order, deduped", () => {
    const text = [
      "Design: [new dashboard](https://claude.ai/design/abc123).",
      "Old Figma: https://www.figma.com/design/KEY/File?node-id=1-2, see also",
      "https://claude.ai/design/abc123 again and https://claude.ai/code/artifact/0f9e-uuid",
      "Not a design: https://github.com/team-dsc/team-dsc/pull/12 and https://linear.app/x/issue/TEA-1",
    ].join("\n");
    expect(extractDesignLinks(text)).toEqual([
      "https://claude.ai/design/abc123",
      "https://www.figma.com/design/KEY/File?node-id=1-2",
      "https://claude.ai/code/artifact/0f9e-uuid",
    ]);
  });

  it("recognises published artifacts and claude.site pages", () => {
    expect(extractDesignLinks("https://claude.ai/public/artifacts/xyz and https://team.claude.site/page")).toEqual([
      "https://claude.ai/public/artifacts/xyz",
      "https://team.claude.site/page",
    ]);
  });

  it("ignores claude.ai chat links and empty input", () => {
    expect(extractDesignLinks("https://claude.ai/chat/123")).toEqual([]);
    expect(extractDesignLinks(null)).toEqual([]);
  });
});

describe("designExportPath", () => {
  it("pins the design under design/<identifier>.html", () => {
    expect(designExportPath("TEA-4540")).toBe("design/TEA-4540.html");
  });
});
