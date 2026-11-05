import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMcpArgs } from "../agent.js";

describe("agent MCP servers", () => {
  it("loads only Symphony's MCP config, never the operator's personal servers", () => {
    expect(buildMcpArgs("/x/agent-mcp.json")).toEqual(["--strict-mcp-config", "--mcp-config", "/x/agent-mcp.json"]);
    expect(buildMcpArgs(undefined)).toEqual([]);
  });

  it("gives agents only the browser server the prompts rely on", () => {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../agent-mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(cfg.mcpServers)).toEqual(["chrome-devtools"]);
  });
});
