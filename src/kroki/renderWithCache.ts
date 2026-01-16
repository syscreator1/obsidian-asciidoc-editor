import type { KrokiClient, KrokiFormat } from "./KrokiClient";
import { fromBase64, sha256Hex, toBase64, type DiagramCacheData } from "./DiagramCache";

export interface RenderResult {
  mime: string;
  data: ArrayBuffer;
  cacheKey: string;
}

function mimeOf(format: KrokiFormat): string {
  return format === "svg" ? "image/svg+xml" : "image/png";
}

export async function renderWithCache(
  client: KrokiClient,
  cache: DiagramCacheData,
  diagramType: string,
  format: KrokiFormat,
  source: string,
): Promise<RenderResult> {
  const cacheKey = sha256Hex(`${diagramType}\n${format}\n${source}`);
  const hit = cache.items[cacheKey];
  if (hit) {
    return { mime: hit.mime, data: fromBase64(hit.base64), cacheKey };
  }

  const data = await client.render(diagramType, format, source);

  cache.items[cacheKey] = {
    mime: mimeOf(format),
    base64: toBase64(data),
    savedAt: Date.now(),
  };

  return { mime: mimeOf(format), data, cacheKey };
}
