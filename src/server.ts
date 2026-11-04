import * as http from "node:http";
import type { Orchestrator } from "./orchestrator.js";
import type { GateStore } from "./gates.js";
import { renderBoard } from "./gate-board.js";
import type { Logger } from "./types.js";

export interface StatusServer {
  port: number;
  close(): Promise<void>;
}

export interface GateServerOptions {
  store: GateStore;
  maxOpenGates: number;
}

const MAX_BODY_BYTES = 16 * 1024;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const GATE_ACTION_RE = /^\/gates\/([0-9a-f-]{36})\/action\/?$/i;

/**
 * Loopback-only HTTP server (127.0.0.1 — no remote exposure).
 *   GET  /status                  orchestrator snapshot (JSON)
 *   GET  /board                   human gate queue (HTML)          [when gates enabled]
 *   GET  /gates                   open gates (JSON)                [when gates enabled]
 *   POST /gates/:id/action        resolve a gate {actionId, note}  [when gates enabled]
 */
export function startStatusServer(
  orchestrator: Orchestrator,
  port: number,
  log: Logger,
  gates: GateServerOptions | null = null,
): Promise<StatusServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handle(req, res).catch(e => {
        log.error(`Status server handler failed: ${String(e)}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      });
    });

    async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      const url = (req.url ?? "/").split("?")[0];
      const method = req.method ?? "GET";

      // ─── Gate action (the only write endpoint) ───────────────────────────────
      const actionMatch = url.match(GATE_ACTION_RE);
      if (actionMatch) {
        if (!gates) return sendJson(res, 404, { error: "gates_disabled" });
        if (method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
        // CSRF guard: only same-origin JSON posts from the board. A cross-origin
        // page can't send application/json without a preflight we never approve,
        // and a present Origin must match the loopback host we're serving.
        const ctype = String(req.headers["content-type"] ?? "");
        if (!ctype.toLowerCase().startsWith("application/json")) {
          return sendJson(res, 415, { error: "json_required" });
        }
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) {
          return sendJson(res, 403, { error: "cross_origin" });
        }
        let payload: { actionId?: unknown; note?: unknown };
        try {
          payload = JSON.parse(await readBody(req)) as typeof payload;
        } catch {
          return sendJson(res, 400, { error: "bad_json" });
        }
        if (typeof payload.actionId !== "string" || !payload.actionId) {
          return sendJson(res, 400, { error: "missing_action_id" });
        }
        const note = typeof payload.note === "string" ? payload.note : null;
        const gate = await gates.store.resolve(actionMatch[1], payload.actionId, note);
        if (!gate) return sendJson(res, 409, { error: "gate_not_resolvable" });
        return sendJson(res, 200, { ok: true, gate });
      }

      if (method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });

      if (url === "/status" || url === "/status/") {
        try {
          const v2 = orchestrator.getV2()?.status();
          return sendJson(res, 200, v2 ? { ...orchestrator.getSnapshot(), v2 } : orchestrator.getSnapshot());
        } catch (e) {
          log.error(`Status snapshot failed: ${String(e)}`);
          return sendJson(res, 500, { error: "snapshot_failed" });
        }
      }

      if (gates && (url === "/board" || url === "/board/")) {
        const html = renderBoard(gates.store.list(), {
          maxOpenGates: gates.maxOpenGates,
          generatedAt: new Date().toLocaleTimeString(),
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (gates && (url === "/gates" || url === "/gates/")) {
        return sendJson(res, 200, { open: gates.store.openGates() });
      }

      if (url === "/" || url === "/health") {
        const endpoints = ["/status"];
        if (gates) endpoints.push("/board", "/gates");
        return sendJson(res, 200, { ok: true, endpoints });
      }

      return sendJson(res, 404, { error: "not_found" });
    }

    server.on("error", (e) => {
      reject(e);
    });

    // Loopback only.
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      log.info("Status server listening", {
        host: "127.0.0.1",
        port: String(boundPort),
        endpoint: `http://127.0.0.1:${boundPort}/status`,
        ...(gates ? { board: `http://127.0.0.1:${boundPort}/board` } : {}),
      });
      resolve({
        port: boundPort,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
