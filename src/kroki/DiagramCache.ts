import { createHash } from "crypto";

export interface CacheRecord {
  mime: string;        // e.g. "image/svg+xml"
  base64: string;      // Payload
  savedAt: number;     // Epoch milliseconds
}

export interface DiagramCacheData {
  version: 1;
  items: Record<string, CacheRecord>;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function toBase64(ab: ArrayBuffer): string {
  // ArrayBuffer -> Uint8Array -> Buffer -> base64
  return Buffer.from(new Uint8Array(ab)).toString("base64");
}

export function fromBase64(b64: string): ArrayBuffer {
  // Buffer -> slice into an ArrayBuffer with the exact range
  const buf = Buffer.from(b64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
