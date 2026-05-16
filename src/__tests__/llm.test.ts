import { describe, it, expect, beforeEach } from "vitest";
import {
  buildCodexExecArgs,
  buildOllamaClaudeLaunchArgs,
  formatCodexError,
  getOllamaClaudeTimeoutMs,
  isQwenBackedProvider,
  isCodexRateLimitError,
  parseResetTimeMs,
  setClaudeBlockedUntil,
  isClaudeBlocked,
  claudeBlockedUntil,
  resetClaudeBlock,
} from "../llm.js";

describe("parseResetTimeMs", () => {
  it("parses pm reset time in a named timezone", () => {
    const ms = parseResetTimeMs("You've hit your limit · resets 5:30pm (Australia/Melbourne)");
    expect(ms).not.toBeNull();
    expect(ms! > Date.now()).toBe(true);
  });

  it("parses am reset time", () => {
    const ms = parseResetTimeMs("resets 7:15am (UTC)");
    expect(ms).not.toBeNull();
  });

  it("returns null when no reset pattern", () => {
    expect(parseResetTimeMs("some unrelated error")).toBeNull();
    expect(parseResetTimeMs("rate limit hit, try later")).toBeNull();
  });

  it("returns null for unparseable timezones", () => {
    expect(parseResetTimeMs("resets 5:30pm (NotARealTZ)")).toBeNull();
  });
});

describe("claude block state", () => {
  beforeEach(() => resetClaudeBlock());

  it("starts unblocked", () => {
    expect(isClaudeBlocked()).toBe(false);
    expect(claudeBlockedUntil()).toBe(0);
  });

  it("blocks until a future timestamp", () => {
    const until = Date.now() + 60_000;
    setClaudeBlockedUntil(until);
    expect(isClaudeBlocked()).toBe(true);
    expect(claudeBlockedUntil()).toBe(until);
  });

  it("ignores earlier timestamps", () => {
    const later = Date.now() + 60_000;
    const earlier = Date.now() + 1_000;
    setClaudeBlockedUntil(later);
    setClaudeBlockedUntil(earlier);
    expect(claudeBlockedUntil()).toBe(later);
  });

  it("treats past timestamps as not blocked", () => {
    setClaudeBlockedUntil(Date.now() - 1000);
    expect(isClaudeBlocked()).toBe(false);
  });
});

describe("buildCodexExecArgs", () => {
  it("uses hosted Codex defaults when no model override is configured", () => {
    const result = buildCodexExecArgs();

    expect(result.providerLabel).toBe("codex");
    expect(result.modelLabel).toBeNull();
    expect(result.args).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("uses the explicit hosted model override when configured", () => {
    const prevModel = process.env.CODEX_MODEL;
    process.env.CODEX_MODEL = "gpt-5.4";

    const result = buildCodexExecArgs();

    expect(result.providerLabel).toBe("codex");
    expect(result.modelLabel).toBe("gpt-5.4");
    expect(result.args).toEqual([
      "exec",
      "-m",
      "gpt-5.4",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);

    if (prevModel === undefined) {
      delete process.env.CODEX_MODEL;
    } else {
      process.env.CODEX_MODEL = prevModel;
    }
  });

  it("uses the explicit local provider when configured", () => {
    const prevModel = process.env.LOCAL_LLM_MODEL;
    process.env.LOCAL_LLM_MODEL = "qwen-local";

    const result = buildCodexExecArgs("ollama");

    expect(result.providerLabel).toBe("ollama");
    expect(result.modelLabel).toBe("qwen-local");
    expect(result.args).toEqual([
      "exec",
      "--oss",
      "--local-provider",
      "ollama",
      "-m",
      "qwen-local",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);

    if (prevModel === undefined) {
      delete process.env.LOCAL_LLM_MODEL;
    } else {
      process.env.LOCAL_LLM_MODEL = prevModel;
    }
  });
});

describe("buildOllamaClaudeLaunchArgs", () => {
  it("uses the Ollama Claude launcher with the default qwen model", () => {
    const result = buildOllamaClaudeLaunchArgs();

    expect(result.providerLabel).toBe("ollama/claude");
    expect(result.modelLabel).toBe("qwen3.5");
    expect(result.args).toEqual([
      "launch",
      "claude",
      "--model",
      "qwen3.5",
    ]);
  });
});

describe("getOllamaClaudeTimeoutMs", () => {
  it("defaults to a longer qwen-specific timeout", () => {
    const prev = process.env.OLLAMA_CLAUDE_TIMEOUT_MS;
    delete process.env.OLLAMA_CLAUDE_TIMEOUT_MS;

    expect(getOllamaClaudeTimeoutMs()).toBe(480000);

    if (prev === undefined) {
      delete process.env.OLLAMA_CLAUDE_TIMEOUT_MS;
    } else {
      process.env.OLLAMA_CLAUDE_TIMEOUT_MS = prev;
    }
  });

  it("uses the explicit qwen timeout override when configured", () => {
    const prev = process.env.OLLAMA_CLAUDE_TIMEOUT_MS;
    process.env.OLLAMA_CLAUDE_TIMEOUT_MS = "180000";

    expect(getOllamaClaudeTimeoutMs()).toBe(180000);

    if (prev === undefined) {
      delete process.env.OLLAMA_CLAUDE_TIMEOUT_MS;
    } else {
      process.env.OLLAMA_CLAUDE_TIMEOUT_MS = prev;
    }
  });
});

describe("isQwenBackedProvider", () => {
  it("matches the direct Ollama Claude launcher", () => {
    expect(isQwenBackedProvider("ollama/claude", "qwen3.5")).toBe(true);
  });

  it("matches Codex local Ollama when using qwen", () => {
    expect(isQwenBackedProvider("ollama", "qwen3.5:9b")).toBe(true);
  });

  it("does not match hosted Codex", () => {
    expect(isQwenBackedProvider("codex", null)).toBe(false);
  });
});

describe("formatCodexError", () => {
  it("filters startup chatter from stderr", () => {
    expect(formatCodexError([
      "Reading additional input from stdin...",
      "OpenAI Codex v0.128.0",
      "The 'gpt-5' model is not supported when using Codex with a ChatGPT account.",
    ], 1)).toBe("The 'gpt-5' model is not supported when using Codex with a ChatGPT account.");
  });

  it("falls back to exit code when stderr only contains ignored chatter", () => {
    expect(formatCodexError([
      "Reading prompt from stdin...",
      "OpenAI Codex v0.128.0",
    ], 2)).toBe("codex exit 2");
  });

  it("deduplicates repeated provider errors and strips ERROR prefixes", () => {
    expect(formatCodexError([
      "ERROR: You've hit your usage limit. To get more access now, send a request to your admin or try again at 2:59 PM.",
      "ERROR: You've hit your usage limit. To get more access now, send a request to your admin or try again at 2:59 PM.",
    ], 1)).toBe("You've hit your usage limit. To get more access now, send a request to your admin or try again at 2:59 PM.");
  });

  it("drops empty ERROR marker lines", () => {
    expect(formatCodexError([
      "ERROR:",
      "You've hit your usage limit. To get more access now, send a request to your admin or try again at 2:59 PM.",
    ], 1)).toBe("You've hit your usage limit. To get more access now, send a request to your admin or try again at 2:59 PM.");
  });
});

describe("isCodexRateLimitError", () => {
  it("matches usage-limit phrasing", () => {
    expect(isCodexRateLimitError("You've hit your usage limit. Try again later.")).toBe(true);
    expect(isCodexRateLimitError("You're out of extra usage")).toBe(true);
  });
});
