import { App, TFile, normalizePath } from "obsidian";
import * as AsciidoctorMod from "asciidoctor";
import type AsciiDocPlugin from "../main";
import { preprocessDiagrams } from "../kroki/preprocessDiagrams";
import { extractDiagramBlocks } from "../kroki/extractDiagramBlocks"; 

export type RenderResult = {
  html: string;
  deps: string[];
};

type IncludeOpts = {
  leveloffset?: number; // 累積対象
  lines?: string; // "2;5..6" etc
  tag?: string;
  tags?: string[];
  indent?: number;
  optional?: boolean;
};

let _adoc: any | null = null;

export async function renderAsciidocToHtml(app: App, plugin: AsciiDocPlugin, file: TFile): Promise<RenderResult> {
  // 反映確認
  console.log("[asciidoc-editor] renderer.ts ACTIVE v2");

  const src = await app.vault.read(file);

  // include 展開（AsciiDoc段階で完了）
  const { masked, map } = maskDiagramBlocks(src);

  // ② 図ブロック以外の include:: だけ展開
  const deps = new Set<string>();
  deps.add(file.path);

  const expandedMasked = await expandVaultIncludes(app, masked, file.path, deps, 0, 30, { leveloffset: 0 });

  // ③ 図ブロックを元に戻す（PlantUML内の include:: はそのまま残る）
  const expanded = unmaskDiagramBlocks(expandedMasked, map);

  const withDiagrams = await preprocessDiagrams(plugin, app, file, deps, expanded);

  const adoc = getAdoc();
  const html = adoc.convert(withDiagrams, {
    safe: "secure",
    header_footer: false,
    attributes: {
      showtitle: true,
      "allow-uri-read": false,
    },
  }) as string;

  return { html, deps: Array.from(deps) };
}

function maskDiagramBlocks(adoc: string): { masked: string; map: Map<string, string> } {
  const blocks = extractDiagramBlocks(adoc);
  const map = new Map<string, string>();

  let masked = adoc;
  let i = 0;

  for (const b of blocks) {
    const token = `@@KROKI_BLOCK_${i}@@`;
    map.set(token, b.raw);
    masked = masked.replace(b.raw, token);
    i++;
  }

  return { masked, map };
}

function unmaskDiagramBlocks(adoc: string, map: Map<string, string>): string {
  let out = adoc;
  for (const [token, raw] of map.entries()) {
    out = out.replace(token, raw);
  }
  return out;
}

/** -----------------------------
 *  Asciidoctor factory resolving
 * ----------------------------- */
function pickFactory(m: any): any {
  if (!m) return null;
  const candidates = [m, m.default, m.default?.default, m.Asciidoctor, m.default?.Asciidoctor];
  for (const c of candidates) if (typeof c === "function") return c;

  if (typeof m === "object") {
    for (const k of Object.keys(m)) {
      const v = (m as any)[k];
      if (typeof v === "function") return v;
      if (v && typeof v === "object") {
        for (const k2 of Object.keys(v)) {
          const v2 = (v as any)[k2];
          if (typeof v2 === "function") return v2;
        }
      }
    }
  }
  return null;
}

function getAdoc(): any {
  if (_adoc) return _adoc;

  const factory = pickFactory(AsciidoctorMod as any);
  if (typeof factory !== "function") {
    const m: any = AsciidoctorMod as any;
    const keys = m ? Object.keys(m) : [];
    const dKeys = m?.default ? Object.keys(m.default) : [];
    throw new Error(
      `Asciidoctor factory not found. keys=[${keys.join(",")}], defaultKeys=[${dKeys.join(",")}]`
    );
  }
  _adoc = factory();
  return _adoc;
}

/** -----------------------------
 *  Include expansion
 *  - include::...[] が改行で分断されても `]` まで結合してから処理する
 *  - lines/tag/tags/indent は「展開前」（元ファイル基準）に適用
 *  - leveloffset は親→子に累積伝播し、挿入ブロックに1回だけ適用（2重適用しない）
 * ----------------------------- */
async function expandVaultIncludes(
  app: App,
  text: string,
  currentFilePath: string,
  deps: Set<string>,
  depth = 0,
  maxDepth = 30,
  inherited: { leveloffset: number } = { leveloffset: 0 }
): Promise<string> {
  if (depth > maxDepth) {
    return `\n// [include] maxDepth reached (${maxDepth}) at ${currentFilePath}\n` + text;
  }

  // ★重要：includeマクロが改行で分割されている場合に備え、] まで結合する
  text = joinBrokenIncludeMacros(text);

  // include::path[opts]
  const re = /^[ \t\uFEFF]*include::\s*(.+?)\[(.*?)\][ \t]*(?:(\/\/|#|;).*)?$/gm;

  let out = "";
  let last = 0;

  for (;;) {
    const m = re.exec(text);
    if (!m) break;

    out += text.slice(last, m.index);

    const rawTarget0 = stripQuotes(((m[1] ?? "") as string).trim());
    const opts = parseIncludeOpts((m[2] ?? "") as string);
    console.log("[asciidoc-editor] include opts =>", opts);

    // foo.adoc#something は今回は無視（#以降を落とす）
    const rawTarget = ((rawTarget0.split("#")[0] ?? "") as string).trim();
    const resolved = resolveVaultPath(currentFilePath, rawTarget);
    const af = resolved ? app.vault.getAbstractFileByPath(resolved) : null;

    if (!resolved || !(af instanceof TFile)) {
      if (!opts.optional) {
        out += `\n// [include] NOT FOUND: ${rawTarget0} (resolved: ${resolved})\n`;
      }
      last = re.lastIndex;
      continue;
    }

    deps.add(af.path);

    // 1) 読む（元ファイル）
    let included = await app.vault.read(af);

    // 2) lines/tag/tags/indent は「展開前」に適用（元ファイル基準）
    included = applyIncludeOptionsBeforeExpand(included, opts);

    // 3) 子 include 展開：親+自分の leveloffset を累積して伝播
    const totalLevelOffset = (inherited.leveloffset ?? 0) + (opts.leveloffset ?? 0);
    console.log("[asciidoc-editor] totalLevelOffset=", totalLevelOffset, "file=", af.path);

    included = await expandVaultIncludes(
      app,
      included,
      af.path,
      deps,
      depth + 1,
      maxDepth,
      { leveloffset: totalLevelOffset }
    );

    // 4) leveloffset は「この include が挿入する塊」に1回だけ適用（2重適用しない）
    if (totalLevelOffset !== 0) {
      console.log("[asciidoc-editor] SHIFT apply:", { file: af.path, totalLevelOffset });
      included = shiftHeadingLevels(included, totalLevelOffset);
    }

    out += `\n// --- include begin: ${af.path} ---\n`;
    out += included;
    out += `\n// --- include end: ${af.path} ---\n`;

    last = re.lastIndex;
  }

  out += text.slice(last);
  return out;
}

/** include::...[] が改行で分断されても ] まで結合する
 *  例:
 *    include::parts/intro.adoc[lines=2;5.
 *    .6]
 *  → include::parts/intro.adoc[lines=2;5..6]
 */
function joinBrokenIncludeMacros(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // include 行っぽいのに ] が無い場合、] が出るまで連結
    if (/^[ \t\uFEFF]*include::/i.test(line) && !line.includes("]")) {
      let buf = line;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? "";
        // 行末コメントなどは考えず、単純に連結（空白は除去）
        buf += next.trim();
        if (buf.includes("]")) break;
        j++;
      }
      out.push(buf);
      i = j; // ここまで消費
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}

function resolveVaultPath(currentFilePath: string, target: string): string {
  let t = (target ?? "").replace(/\\/g, "/").trim();
  if (/^https?:\/\//i.test(t)) return "";

  if (t.startsWith("/")) {
    t = t.slice(1);
  } else {
    const baseDir = currentFilePath.includes("/")
      ? currentFilePath.slice(0, currentFilePath.lastIndexOf("/"))
      : "";
    t = baseDir ? `${baseDir}/${t}` : t;
  }

  if (!/\.[a-zA-Z0-9]+$/.test(t)) t += ".adoc";
  return normalizePath(t);
}

/** -----------------------------
 *  Include options (parse/apply)
 * ----------------------------- */
function parseIncludeOpts(raw: string): IncludeOpts {
  const opts: IncludeOpts = {};
  const s = (raw ?? "").trim();
  if (!s) return opts;

  // 例: leveloffset=+1, lines=2;5..6, tags=public;internal, opts=optional
  // ※ lines の中にも ; があるので、単純 split(/[;,]/) は壊れる
  // 方針： key=value だけ拾う（value は次の key= が来るまで）
  const tokens = tokenizeKeyValueOptions(s);

  for (const { key, val } of tokens) {
    const k = key.toLowerCase();
    const v = stripQuotes(val.trim());

    if (k === "leveloffset") {
      // "+1" / "-1" / "1"
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) opts.leveloffset = n;
    } else if (k === "lines") {
      opts.lines = v;
    } else if (k === "tag") {
      opts.tag = v;
    } else if (k === "tags") {
      opts.tags = v.split(/[;,\|]/).map((x) => x.trim()).filter(Boolean);
    } else if (k === "indent") {
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) opts.indent = n;
    } else if (k === "opts") {
      const flags = v.split(/[;,\|]/).map((x) => x.trim().toLowerCase());
      if (flags.includes("optional")) opts.optional = true;
    }
  }

  return opts;
}

/**
 * "lines=2;5..6,leveloffset=+1" のような文字列を
 * [{key:"lines",val:"2;5..6"}, {key:"leveloffset",val:"+1"}] にする
 */
function tokenizeKeyValueOptions(s: string): Array<{ key: string; val: string }> {
  const res: Array<{ key: string; val: string }> = [];
  const re = /([a-zA-Z0-9_-]+)\s*=/g;

  const hits: Array<{ key: string; idx: number; end: number }> = [];
  for (;;) {
    const m = re.exec(s);
    if (!m) break;
    const key = (m[1] ?? "").trim();
    if (!key) continue;
    hits.push({ key, idx: m.index, end: re.lastIndex });
  }
  if (hits.length === 0) return res;

  for (let i = 0; i < hits.length; i++) {
    const cur = hits[i]!;
    const next = hits[i + 1];
    let val = s.slice(cur.end, next ? next.idx : s.length).trim();

    // "..., key=VALUE," の末尾区切りだけ落とす
    val = val.replace(/[,;]+$/, "").trim();
    // "key=,VALUE" のような変な形だけ先頭区切りを落とす
    val = val.replace(/^[,;]+\s*/, "");

    res.push({ key: cur.key, val });
  }
  return res;
}

function applyIncludeOptionsBeforeExpand(text: string, opts: IncludeOpts): string {
  let out = text;

  // lines（元ファイルの行番号基準）
  if (opts.lines) {
    out = pickLines(out, opts.lines);
  }

  // tag/tags（元ファイルの tag:: / end:: ブロック基準）
  if (opts.tag) {
    out = pickTags(out, new Set([opts.tag]));
  } else if (opts.tags && opts.tags.length > 0) {
    out = pickTags(out, new Set(opts.tags));
  }

  // indent（行頭にスペース付与）
  if (typeof opts.indent === "number" && !Number.isNaN(opts.indent) && opts.indent > 0) {
    const pad = " ".repeat(opts.indent);
    out = out
      .split(/\r?\n/)
      .map((l) => (l.length ? pad + l : l))
      .join("\n");
  }

  return out;
}

/** lines=2;5..6 を解釈して行を抽出（1-based, inclusive） */
/** lines=2;5..6 を解釈して行を抽出（1-based, inclusive） */
function pickLines(text: string, spec: string): string {
  const linesArr = text.split(/\r?\n/);

  const picked = new Set<number>();
  const parts = (spec ?? "")
    .split(/[;,\|]/)
    .map((x) => x.trim())
    .filter(Boolean);

  for (const p of parts) {
    // "5..6"
    const rr = /^(\d+)\s*\.\.\s*(\d+)$/.exec(p);
    if (rr && rr[1] && rr[2]) {
      const a = parseInt(rr[1], 10);
      const b = parseInt(rr[2], 10);
      if (!Number.isNaN(a) && !Number.isNaN(b)) {
        const start = Math.min(a, b);
        const end = Math.max(a, b);
        for (let n = start; n <= end; n++) picked.add(n);
      }
      continue;
    }

    // "7"
    if (/^\d+$/.test(p)) {
      const nn = parseInt(p!, 10);
      if (!Number.isNaN(nn)) picked.add(nn);
    }
  }

  // ---- 飛び飛び抽出の境界に空行を入れてブロックを切る ----
  const out: string[] = [];
  let prevPickedLineNo: number | null = null;

  for (let i = 0; i < linesArr.length; i++) {
    const lineNo = i + 1; // 1-based
    if (!picked.has(lineNo)) continue;

    const line = linesArr[i];
    if (line == null) continue; // undefined/null を完全排除

    // 連続していない行へジャンプ → 空行挿入
    if (prevPickedLineNo !== null && lineNo !== prevPickedLineNo + 1) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    }

    // 見出し行が段落の途中に入るのを防ぐ
    if (/^\s*=+\s+/.test(line)) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    }

    out.push(line);
    prevPickedLineNo = lineNo;
  }

  return out.join("\n");
}

/**
 * tag::name[] ～ end::name[] のブロックから、指定 tag の中身だけ抽出
 * - tag::public[] など（Asciidoctorの一般的なタグ形式）
 */
function pickTags(text: string, want: Set<string>): string {
  const lines = text.split(/\r?\n/);

  const reStart = /^\s*tag::([A-Za-z0-9_.:-]+)\[\]\s*$/;
  const reEnd = /^\s*end::([A-Za-z0-9_.:-]+)\[\]\s*$/;

  let capturing = false;
  let currentTag: string | null = null;

  const out: string[] = [];

  for (const line of lines) {
    const ms = reStart.exec(line);
    if (ms) {
      const tag = (ms[1] ?? "").trim();
      if (!tag) {
        capturing = false;
        currentTag = null;
        continue;
      }
      currentTag = tag;
      capturing = want.has(tag);
      continue;
    }

    const me = reEnd.exec(line);
    if (me) {
      const tag = (me[1] ?? "").trim();
      // とにかく閉じる（ズレても閉じる）
      capturing = false;
      currentTag = null;
      continue;
    }

    if (capturing) out.push(line);
  }

  return out.join("\n");
}

/** -----------------------------
 *  Heading level shift
 *  - Asciidoc の "=" 見出しを +N / -N する
 *    "= H1" -> "== H1" (offset +1)
 * ----------------------------- */
function shiftHeadingLevels(text: string, offset: number): string {
  if (offset === 0) return text;

  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const m = /^(\s*)(=+)(\s+.*)$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }

    const indent = m[1] ?? "";
    const eq = m[2] ?? "";
    const rest = m[3] ?? "";

    const cur = eq.length;
    let next = cur + offset;

    // Asciidoc的に 1 未満は作れないので 1 に丸め
    if (next < 1) next = 1;

    out.push(indent + "=".repeat(next) + rest);
  }

  return out.join("\n");
}

function stripQuotes(s: string): string {
  const t = (s ?? "").trim();
  if (!t) return t;
  return t.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}
