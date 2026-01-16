import type AsciiDocPlugin from "../main";
import { KrokiClient } from "./KrokiClient";
import { renderWithCache } from "./renderWithCache";
import { extractDiagramBlocks } from "./extractDiagramBlocks";
import type { App, TFile } from "obsidian";
import { expandPlantumlIncludes } from "./expandPlantumlIncludes";

function extractSvgText(svgText: string): string {
  try {
    // Obsidian (Desktop) runs in a browser environment, so DOMParser is available
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const root = doc.documentElement;
    if (!root) return "";

    // PlantUML/Kroki SVGs often store text content in text/tspan elements
    const texts = Array.from(root.querySelectorAll("text, tspan"));

    const chunks: string[] = [];
    for (const el of texts) {
      const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) chunks.push(t);
    }

    // Light de-duplication while preserving order (the same terms may appear many times)
    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const c of chunks) {
      if (seen.has(c)) continue;
      seen.add(c);
      uniq.push(c);
    }

    return uniq.join("\n");
  } catch {
    return "";
  }
}

// Lightweight hash for IDs (FNV-1a 32-bit)
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // unsigned
  return (h >>> 0).toString(16);
}

function buildDiagramWrapperHtml(params: {
  diagramType: string;
  svgOrImgHtml: string; // A div containing the svg, or an <img> tag
  indexText: string;    // For Ctrl+F (do not hide with display:none)
  sourceForId: string;  // For stable ID generation
}): string {
  const { diagramType, svgOrImgHtml, indexText, sourceForId } = params;
  const id = `kroki-${escapeHtml(diagramType)}-${hash32(sourceForId).slice(0, 8)}`;

  // ⚠ display:none often won't be picked up by Ctrl+F, so move it "off-screen"
  // Note: aria-hidden=true to avoid screen reader output
  const indexHtml = indexText
    ? `<div class="kroki-search-index" aria-hidden="true">${escapeHtml(indexText)}</div>`
    : "";

  return `
<div class="kroki-diagram-wrap" id="${id}" data-kroki-type="${escapeHtml(diagramType)}">
  ${svgOrImgHtml}
  ${indexHtml}
</div>
`.trim();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]
  );
}

function svgToInlineHtml(svgText: string, diagramType: string): string {
  return `<div class="kroki-diagram" data-kroki-type="${escapeHtml(diagramType)}">${svgText}</div>`;
}

function buildKrokiErrorHtml(params: {
  diagramType: string;
  format: string;
  message: string;
  source: string;
}): string {
  const { diagramType, format, message, source } = params;

  return `
<div class="kroki-error" data-kroki-type="${escapeHtml(diagramType)}" data-kroki-format="${escapeHtml(format)}">
  <div class="kroki-error__head">
    <strong>Kroki render failed</strong>
    <span class="kroki-error__meta">${escapeHtml(diagramType)} / ${escapeHtml(format)}</span>
  </div>
  <div class="kroki-error__msg">${escapeHtml(message)}</div>
  <details class="kroki-error__details">
    <summary>Show source</summary>
    <pre class="kroki-error__src">${escapeHtml(source)}</pre>
  </details>
</div>
`.trim();
}

/**
 * Final approach for "200 OK + error SVG" cases
 * - Pure string matching causes false positives (users can write "parse error" in their diagram)
 * - So we require: an "error phrase" AND an "abnormal SVG structure"
 */
function isLikelyErrorSvg(svgText: string, diagramType: string): boolean {
  // The head is enough (keep it lightweight)
  const head = svgText.slice(0, 12000);
  const s = head.toLowerCase();

  // 1) Error phrases (weak condition)
  // Note: avoid plain "error" because it produces too many false positives
  const hasErrorPhrase =
    s.includes("parse error") ||
    s.includes("syntax error") ||
    s.includes("lexical error") ||
    s.includes("unexpected token") ||
    s.includes("failed to parse") ||
    s.includes("cannot parse") ||
    s.includes("diagram syntax error");

  if (!hasErrorPhrase) return false;

  // 2) SVG structure (strong condition)
  // Normal diagrams contain a decent amount of path/rect/polygon.
  // Error SVGs often contain mostly text and very few shapes.
  const pathCount = (head.match(/<path\b/gi) ?? []).length;
  const rectCount = (head.match(/<rect\b/gi) ?? []).length;
  const polyCount = (head.match(/<polygon\b/gi) ?? []).length;
  const lineCount = (head.match(/<line\b/gi) ?? []).length;
  const shapeCount = pathCount + rectCount + polyCount + lineCount;

  // Mermaid often returns error SVGs that contain only text, so be stricter
  if (diagramType === "mermaid") {
    // Normal diagrams usually contain multiple rect/polygon/path elements
    return shapeCount <= 1;
  }

  // PlantUML / Graphviz etc. less frequently return 200+SVG on error,
  // but when they do, shape counts tend to be extremely low as well.
  return shapeCount <= 1;
}

type CacheItem = { savedAt?: number };
function trimCache(cache: { items: Record<string, CacheItem> }, maxItems: number) {
  if (!maxItems || maxItems <= 0) return;

  const keys = Object.keys(cache.items) as string[];
  if (keys.length <= maxItems) return;

  keys.sort((a, b) => {
    const sa = cache.items[a]?.savedAt ?? 0;
    const sb = cache.items[b]?.savedAt ?? 0;
    return sa - sb;
  });

  const remove = keys.length - maxItems;
  for (let i = 0; i < remove; i++) {
    const k = keys[i];
    if (k !== undefined) delete cache.items[k];
  }
}

/**
 * AsciiDoc text -> AsciiDoc text with embedded Kroki diagrams
 */
export async function preprocessDiagrams(
  plugin: AsciiDocPlugin,
  app: App,
  file: TFile,
  deps: Set<string>,
  adocText: string
): Promise<string> {
  const blocks = extractDiagramBlocks(adocText);
  if (blocks.length === 0) return adocText;

  const cacheBefore = Object.keys(plugin.diagramCache.items).length;

  const client = new KrokiClient({
    baseUrl: plugin.settings.krokiBaseUrl,
    timeoutMs: plugin.settings.timeoutMs,
    userAgent: "obsidian-asciidoc-kroki",
  });

  let out = adocText;

  for (const b of blocks) {
    // whitelist
    if (!plugin.settings.enabledDiagramTypes.includes(b.diagramType)) continue;

    const format = (b.format ?? plugin.settings.defaultFormat) as "svg" | "png";

    let sourceForRender = b.source;

    try {
      // ★Expand include:: inside PlantUML blocks before sending to Kroki
      if (b.diagramType === "plantuml") {
        const before = b.source;
        console.log("[asciidoc-editor] plantuml before len", before.length);

        try {
          sourceForRender = await expandPlantumlIncludes({
            app,
            baseFile: file,  // Resolve relative paths against the currently open .adoc
            text: b.source,
            deps,            // Add include sources to deps (auto re-render on updates)
            maxDepth: 20,
          });

          console.log("[asciidoc-editor] plantuml include expand OK", {
            afterLen: sourceForRender.length,
            hasIncludeAfter: sourceForRender.includes("include::"),
            deps: Array.from(deps),
          });
        } catch (err: any) {
          console.error("[asciidoc-editor] plantuml include expand error", err);
          throw err;
        }


      }

      const result = await renderWithCache(
        client,
        plugin.diagramCache,
        b.diagramType,
        format,
        sourceForRender
      );

      if (format === "svg") {
        const svgText = new TextDecoder("utf-8").decode(result.data);

        // ★Detect "error SVG" returned as 200+SVG (final form with low false positives)
        if (isLikelyErrorSvg(svgText, b.diagramType)) {
          const html = buildKrokiErrorHtml({
            diagramType: b.diagramType,
            format,
            message: "Diagram syntax error (reported by Kroki)",
            source: sourceForRender,
          });
          out = out.replace(b.raw, `++++\n${html}\n++++`);
        } else {
          const svgText = new TextDecoder("utf-8").decode(result.data);

          // ★The 200+SVG error detection logic can stay as-is (omitted)

          const diagramHtml = svgToInlineHtml(svgText, b.diagramType);

          // ★Use the PlantUML source itself as the search index
          const indexText = sourceForRender ?? b.source;

          // ★For stable IDs: use expanded source (when PlantUML include is supported)
          const wrapped = buildDiagramWrapperHtml({
            diagramType: b.diagramType,
            svgOrImgHtml: diagramHtml,
            indexText,
            sourceForId: sourceForRender ?? b.source, // If using sourceForRender below, prefer it
          });

          out = out.replace(b.raw, `++++\n${wrapped}\n++++`);
        }
      } else {
        // png: data url
        const b64 = Buffer.from(new Uint8Array(result.data)).toString("base64");
        const html = `<img class="kroki-diagram" data-kroki-type="${escapeHtml(
          b.diagramType
        )}" src="data:image/png;base64,${b64}" />`;
        out = out.replace(b.raw, `++++\n${html}\n++++`);
      }
    } catch (e: any) {
      // Exceptions such as HTTP errors / timeouts end up here
      const msg = e?.message ? String(e.message) : String(e);
      const html = buildKrokiErrorHtml({
        diagramType: b.diagramType,
        format,
        message: msg,
        source: sourceForRender,
      });
      out = out.replace(b.raw, `++++\n${html}\n++++`);
    }
  }

  // Save only when the cache size increased (performance optimization)
  const cacheAfter = Object.keys(plugin.diagramCache.items).length;
  if (cacheAfter !== cacheBefore) {
    trimCache(plugin.diagramCache, plugin.settings.cacheMaxItems);
    await plugin.saveSettings();
  }

  return out;
}
