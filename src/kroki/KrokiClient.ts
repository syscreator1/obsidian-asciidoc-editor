import { requestUrl, type RequestUrlResponse } from "obsidian";

export type KrokiFormat = "svg" | "png";

export interface KrokiClientOptions {
  baseUrl: string;
  timeoutMs: number;
  userAgent?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  if (!ms || ms <= 0) return p;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}: ${ms}ms`)), ms)),
  ]);
}

export class KrokiClient {
  constructor(private opts: KrokiClientOptions) {}

  async render(diagramType: string, format: KrokiFormat, source: string): Promise<ArrayBuffer> {
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    const url = `${base}/${encodeURIComponent(diagramType)}/${encodeURIComponent(format)}`;

    const req = requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        ...(this.opts.userAgent ? { "User-Agent": this.opts.userAgent } : {}),
      },
      body: source,
    });

    const res: RequestUrlResponse = await withTimeout(req, this.opts.timeoutMs, "Kroki request timeout");

    if (res.status < 200 || res.status >= 300) {
      const preview = (res.text ?? "").slice(0, 400);
      throw new Error(`Kroki render failed: ${res.status}\n${preview}`);
    }

    if (res.arrayBuffer) return res.arrayBuffer;
    if (res.text != null) return new TextEncoder().encode(res.text).buffer;

    throw new Error("Kroki response has no body");
  }
}
