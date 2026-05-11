import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { sanitizeKey, getWorkspacePath, validateWorkspacePath } from "../workspace.js";

describe("sanitizeKey", () => {
  it("preserves safe characters", () => {
    expect(sanitizeKey("ABC-123_v1.2")).toBe("ABC-123_v1.2");
  });

  it("replaces unsafe characters with underscore", () => {
    expect(sanitizeKey("foo/bar")).toBe("foo_bar");
    expect(sanitizeKey("foo bar")).toBe("foo_bar");
    expect(sanitizeKey("../etc")).toBe(".._etc");
    expect(sanitizeKey("a$b!c")).toBe("a_b_c");
  });
});

describe("getWorkspacePath", () => {
  it("joins root and sanitized identifier", () => {
    expect(getWorkspacePath("/tmp/ws", "ABC-1")).toBe(path.join("/tmp/ws", "ABC-1"));
  });

  it("sanitizes identifiers with separators", () => {
    expect(getWorkspacePath("/tmp/ws", "../escape")).toBe(path.join("/tmp/ws", ".._escape"));
  });
});

describe("validateWorkspacePath", () => {
  it("accepts paths inside the root", () => {
    expect(() => validateWorkspacePath("/tmp/ws", "/tmp/ws/abc")).not.toThrow();
  });

  it("accepts the root itself", () => {
    expect(() => validateWorkspacePath("/tmp/ws", "/tmp/ws")).not.toThrow();
  });

  it("rejects paths that escape the root", () => {
    expect(() => validateWorkspacePath("/tmp/ws", "/tmp/other")).toThrow(/escapes root/);
    expect(() => validateWorkspacePath("/tmp/ws", "/etc/passwd")).toThrow(/escapes root/);
  });

  it("rejects sibling roots that share a prefix", () => {
    expect(() => validateWorkspacePath("/tmp/ws", "/tmp/ws-other/foo")).toThrow(/escapes root/);
  });
});
