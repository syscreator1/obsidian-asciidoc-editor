export interface DiagramBlock {
  raw: string;              // 置換対象の元テキスト
  diagramType: string;      // plantuml / mermaid / graphviz ...
  format: "svg" | "png";    // default svg
  source: string;           // ----内
}

/**
 * NOTE:
 * - 「ブロック属性行」→「----」→「内容」→「----」だけ抽出
 * - ネストや他の区切り(....)は後で必要なら拡張
 */
export function extractDiagramBlocks(adoc: string): DiagramBlock[] {
  const blocks: DiagramBlock[] = [];

  /**
   * [plantuml, ...]
   *
   * ----
   * body
   * ----
   *
   * ↑ 空行をすべて許容する
   */
  const re =
    /^\[([^\]\n]+)\][ \t]*\r?\n(?:\r?\n)*----[ \t]*\r?\n([\s\S]*?)\r?\n----[ \t]*(?:\r?\n|$)/gm;

  for (const m of adoc.matchAll(re)) {
    const raw = m[0];
    const attr = (m[1] ?? "").trim();
    const body = m[2] ?? "";

    const { diagramType, format } = parseAttr(attr);
    if (!diagramType) continue;

    blocks.push({
      raw,
      diagramType,
      format,
      source: body,
    });
  }

  return blocks;
}


function parseAttr(attr: string): { diagramType: string; format: "svg" | "png" } {
  // 例: "plantuml, format=svg, role=foo"
  const parts = attr.split(",").map((s) => s.trim()).filter(Boolean);
  const diagramType = parts[0] ?? "";

  let format: "svg" | "png" = "svg";
  for (const p of parts.slice(1)) {
    const mm = /^format\s*=\s*(svg|png)\s*$/i.exec(p);
    const f = mm?.[1]?.toLowerCase();
    if (f === "svg" || f === "png") format = f;
  }

  // diagramTypeのホワイトリストは設定から作るのが安全
  return { diagramType, format };
}
