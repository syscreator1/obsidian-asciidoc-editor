export type HighlightStrength = "weak" | "medium" | "strong";

export interface AsciidocKrokiSettings {
  krokiBaseUrl: string;           // default "https://kroki.io"
  defaultFormat: "svg" | "png";   // default "svg"
  timeoutMs: number;              // default 15000
  enabledDiagramTypes: string[];  // default ["plantuml","mermaid","graphviz"]
  allowHttp: boolean;             // default false
  cacheMaxItems: number;          // default 300
  highlightStrength: HighlightStrength;
  zoomDefaultPct: number;
}

export const DEFAULT_SETTINGS: AsciidocKrokiSettings = {
  krokiBaseUrl: "https://kroki.io",
  defaultFormat: "svg",
  timeoutMs: 15000,
  enabledDiagramTypes: ["plantuml", "mermaid", "graphviz"],
  allowHttp: false,
  cacheMaxItems: 300,
  highlightStrength: "medium",
  zoomDefaultPct: 100,
};

export interface CacheRecord {
  mime: string;     // "image/svg+xml" / "image/png"
  base64: string;
  savedAt: number;
}

export interface DiagramCacheData {
  version: 1;
  items: Record<string, CacheRecord>;
}

export interface PluginDataV1 {
  version: 1;
  settings: AsciidocKrokiSettings;
  diagramCache: DiagramCacheData;
}

export const DEFAULT_CACHE: DiagramCacheData = {
  version: 1,
  items: {},
};
