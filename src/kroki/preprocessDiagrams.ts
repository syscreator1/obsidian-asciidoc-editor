import type AsciiDocPlugin from "../main";
import { KrokiClient } from "./KrokiClient";
import { renderWithCache } from "./renderWithCache";
import { extractDiagramBlocks } from "./extractDiagramBlocks";
import type { App, TFile } from "obsidian";
import { expandPlantumlIncludes } from "./expandPlantumlIncludes";

function extractSvgText(svgText: string): string {
  try {
    // Obsidian(Desktop)はブラウザ環境なのでDOMParserが使える
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const root = doc.documentElement;
    if (!root) return "";

    // PlantUML/KrokiのSVGは text/tspan に文字が入ることが多い
    const texts = Array.from(root.querySelectorAll("text, tspan"));

    const chunks: string[] = [];
    for (const el of texts) {
      const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) chunks.push(t);
    }

    // 同じ語が大量に出ることがあるので軽く重複除去（順序維持）
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

// ID用の軽量ハッシュ（FNV-1a 32bit）
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
  svgOrImgHtml: string; // svgを含むdiv or imgタグ
  indexText: string;    // Ctrl+F 用（display:noneにしない）
  sourceForId: string;  // idの安定化用
}): string {
  const { diagramType, svgOrImgHtml, indexText, sourceForId } = params;
  const id = `kroki-${escapeHtml(diagramType)}-${hash32(sourceForId).slice(0, 8)}`;

  // ⚠ display:none は Ctrl+F が拾わないことが多いので「画面外」に出す
  // ※ aria-hidden=true で読み上げ抑制
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
 * 「200 OK + エラーSVG」対策の完成形
 * - 文字列だけでは誤検知する（ユーザーが図に "parse error" と書ける）
 * - なので「エラーフレーズ」AND「SVG構造の異常」で判定する
 */
function isLikelyErrorSvg(svgText: string, diagramType: string): boolean {
  // 先頭だけで十分（重くしない）
  const head = svgText.slice(0, 12000);
  const s = head.toLowerCase();

  // 1) エラーフレーズ（弱条件）
  // ※ "error" 単体は誤検知が多いので使わない
  const hasErrorPhrase =
    s.includes("parse error") ||
    s.includes("syntax error") ||
    s.includes("lexical error") ||
    s.includes("unexpected token") ||
    s.includes("failed to parse") ||
    s.includes("cannot parse") ||
    s.includes("diagram syntax error");

  if (!hasErrorPhrase) return false;

  // 2) SVG構造（強条件）
  // 正常図は path/rect/polygon がそれなりに出る。
  // エラーSVGは text だけ、shapeがほぼ無いことが多い。
  const pathCount = (head.match(/<path\b/gi) ?? []).length;
  const rectCount = (head.match(/<rect\b/gi) ?? []).length;
  const polyCount = (head.match(/<polygon\b/gi) ?? []).length;
  const lineCount = (head.match(/<line\b/gi) ?? []).length;
  const shapeCount = pathCount + rectCount + polyCount + lineCount;

  // Mermaid は特に「エラーSVGが text だけ」になりやすいので厳しめに
  if (diagramType === "mermaid") {
    // 正常図はだいたい rect/polygon/path が複数出る
    return shapeCount <= 1;
  }

  // PlantUML / Graphviz 等は、エラー時に 200+SVG になる頻度が低いが、
  // なっても shape が極端に少ないことが多いので同様に判定
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
 * AsciiDoc text -> Kroki図を埋め込んだ AsciiDoc text
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
      // ★ PlantUML ブロック内の include:: を展開してから Kroki に投げる
      if (b.diagramType === "plantuml") {
        const before = b.source;
        console.log("[asciidoc-editor] plantuml before len", before.length);

        try {
          sourceForRender = await expandPlantumlIncludes({
            app,
            baseFile: file,  // 相対パス基準は「今開いている .adoc」
            text: b.source,
            deps,            // include 元を deps に足す（更新で自動再描画）
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

        // ★ 200+SVG で返ってくる「エラーSVG」を検出（誤検知しない完成形）
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

          // ★ 200+SVGエラー検出の部分はそのままでOK（省略）

          const diagramHtml = svgToInlineHtml(svgText, b.diagramType);

          // ★検索インデックスは「PlantUMLソースそのもの」を使う
          const indexText = sourceForRender ?? b.source;

          // ★ id安定化用：展開後を使う（PlantUML include対応してる場合）
          const wrapped = buildDiagramWrapperHtml({
            diagramType: b.diagramType,
            svgOrImgHtml: diagramHtml,
            indexText,
            sourceForId: sourceForRender ?? b.source, // ※下でsourceForRenderを使っているならそちら
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
      // HTTPエラー / timeout などの「例外」はここ
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

  // キャッシュが増えた時だけ保存（性能対策）
  const cacheAfter = Object.keys(plugin.diagramCache.items).length;
  if (cacheAfter !== cacheBefore) {
    trimCache(plugin.diagramCache, plugin.settings.cacheMaxItems);
    await plugin.saveSettings();
  }

  return out;
}






