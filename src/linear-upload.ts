import * as fs from "node:fs";
import * as path from "node:path";
import { executeGraphQL } from "./linear.js";
import type { TrackerConfig } from "./types.js";

/**
 * Upload a local file (e.g. a screenshot) to Linear's storage and return its
 * asset URL, which renders inline in issue comments as `![label](url)`.
 * Two steps: ask Linear for a signed upload URL, then PUT the bytes to it.
 */

const FILE_UPLOAD = `
  mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
    fileUpload(contentType: $contentType, filename: $filename, size: $size) {
      success
      uploadFile { uploadUrl assetUrl headers { key value } }
    }
  }
`;

interface FileUploadPayload {
  fileUpload?: {
    success: boolean;
    uploadFile: { uploadUrl: string; assetUrl: string; headers: Array<{ key: string; value: string }> } | null;
  } | null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".txt": "text/plain", ".json": "application/json", ".html": "text/html",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export async function uploadToLinear(tracker: TrackerConfig, file: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const bytes = fs.readFileSync(file);
  const contentType = contentTypeFor(file);
  const data = (await executeGraphQL(tracker, FILE_UPLOAD, {
    contentType,
    filename: path.basename(file),
    size: bytes.length,
  })) as FileUploadPayload;
  const up = data.fileUpload?.uploadFile;
  if (!data.fileUpload?.success || !up) throw new Error(`Linear fileUpload failed for ${path.basename(file)}`);
  const headers: Record<string, string> = { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000" };
  for (const h of up.headers) headers[h.key] = h.value;
  const res = await fetchImpl(up.uploadUrl, { method: "PUT", headers, body: bytes });
  if (!res.ok) throw new Error(`Linear upload PUT ${res.status} for ${path.basename(file)}`);
  return up.assetUrl;
}
