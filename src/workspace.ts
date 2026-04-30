import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

export function sanitizeKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function getWorkspacePath(root: string, identifier: string): string {
  return path.join(root, sanitizeKey(identifier));
}

export function validateWorkspacePath(root: string, workspacePath: string): void {
  const normalizedRoot = path.resolve(root);
  const normalizedWs = path.resolve(workspacePath);
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  if (!normalizedWs.startsWith(prefix) && normalizedWs !== normalizedRoot) {
    throw new Error(`Workspace path escapes root: ${workspacePath}`);
  }
}

export interface WorkspaceResult {
  path: string;
  createdNow: boolean;
}

export async function ensureWorkspace(root: string, identifier: string): Promise<WorkspaceResult> {
  const wsPath = getWorkspacePath(root, identifier);
  validateWorkspacePath(root, wsPath);

  if (!fs.existsSync(wsPath)) {
    fs.mkdirSync(wsPath, { recursive: true });
    return { path: wsPath, createdNow: true };
  }

  const stat = fs.statSync(wsPath);
  if (!stat.isDirectory()) {
    fs.rmSync(wsPath);
    fs.mkdirSync(wsPath, { recursive: true });
    return { path: wsPath, createdNow: true };
  }

  return { path: wsPath, createdNow: false };
}

export async function removeWorkspace(
  root: string,
  identifier: string,
  beforeRemoveHook?: string,
  hookTimeoutMs = 60000
): Promise<void> {
  const wsPath = getWorkspacePath(root, identifier);
  validateWorkspacePath(root, wsPath);

  if (!fs.existsSync(wsPath)) return;

  if (beforeRemoveHook) {
    try {
      await runHook(beforeRemoveHook, wsPath, hookTimeoutMs);
    } catch (e) {
      console.warn(`[symphony] before_remove hook failed for ${identifier}: ${e}`);
    }
  }

  try {
    fs.rmSync(wsPath, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[symphony] failed to remove workspace ${wsPath}: ${e}`);
  }
}

export async function runHook(script: string, cwd: string, timeoutMs: number): Promise<void> {
  // Pipe the script to `bash -l` via stdin. Inlining via `bash -lc "<script>"` breaks on
  // multi-line scripts because the host shell collapses real newlines, leaving bash to
  // parse one giant line where any apostrophe (e.g. "project's") is read as an unmatched
  // single-quote.
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-l"], { cwd, stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 10 * 1024 * 1024) stdout = stdout.slice(-2_000_000);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 10 * 1024 * 1024) stderr = stderr.slice(-2_000_000);
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 3000);
      reject(new Error(`Hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (stdout) console.log(`[symphony] hook stdout: ${stdout.slice(0, 2000)}`);
      if (stderr) console.log(`[symphony] hook stderr: ${stderr.slice(0, 2000)}`);
      if (code !== 0) {
        reject(new Error(`Hook exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve();
    });

    proc.stdin.write(script);
    proc.stdin.end();
  });
}
