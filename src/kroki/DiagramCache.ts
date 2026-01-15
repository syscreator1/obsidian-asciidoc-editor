import { createHash } from "crypto";

export interface CacheRecord {
  mime: string;        // "image/svg+xml" etc
  base64: string;      // 本体
  savedAt: number;     // epoch ms
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
  // Buffer -> (正確な範囲で) ArrayBuffer に切り出す
  const buf = Buffer.from(b64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

