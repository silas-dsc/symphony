import * as http from "node:http";
import type { Orchestrator } from "./orchestrator.js";
import type { Logger } from "./types.js";

export interface StatusServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Read-only JSON status server bound to 127.0.0.1 only — no remote exposure.
 * Single endpoint: `GET /status` returns the orchestrator snapshot.
 */
export function startStatusServer(
  orchestrator: Orchestrator,
  port: number,
  log: Logger
): Promise<StatusServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }

      const url = req.url ?? "/";
      if (url === "/status" || url === "/status/") {
        try {
          const snap = orchestrator.getSnapshot();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(snap));
        } catch (e) {
          log.error(`Status snapshot failed: ${String(e)}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "snapshot_failed" }));
        }
        return;
      }

      if (url === "/" || url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, endpoints: ["/status"] }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

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
      });
      resolve({
        port: boundPort,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
