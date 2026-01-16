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
  leveloffset?: number; // Accumulates and propagates
  lines?: string; // "2;5..6" etc
  tag?: string;
  tags?: string[];
  indent?: number;
  optional?: boolean;
};

let _adoc: any | null = null;

export async function renderAsciidocToHtml(app: App, plugin: AsciiDocPlugin, file: TFile): Promise<RenderResult> {
  // Verify that changes are applied
  console.log("[asciidoc-editor] renderer.ts ACTIVE v2");

  const src = await app.vault.read(file);

  // Expand includes (completed at the AsciiDoc stage)
  const { masked, map } = maskDiagramBlocks(src);

  // ② Expand include:: directives except inside diagram blocks
  const deps = new Set<string>();
  deps.add(file.path);

  const expandedMasked = await expandVaultIncludes(app, masked, file.path, deps, 0, 30, { leveloffset: 0 });

  // ③ Restore diagram blocks (include:: inside PlantUML remains as-is)
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
 *  - If include::...[] is split across lines, join until `]` before processing
 *  - Apply lines/tag/tags/indent BEFORE expanding (based on the original file)
 *  - leveloffset accumulates from parent to child, and is applied once to the inserted block (avoid double-apply)
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

  // ★Important: join include macros that are broken across lines (until `]`)
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

    // Ignore foo.adoc#something for now (drop the #... part)
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

    // 1) Read (original file)
    let included = await app.vault.read(af);

    // 2) Apply lines/tag/tags/indent BEFORE expansion (based on the original file)
    included = applyIncludeOptionsBeforeExpand(included, opts);

    // 3) Expand child includes: propagate accumulated leveloffset (parent + current)
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

    // 4) Apply leveloffset once to the inserted block (avoid double-apply)
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

/** Join include::...[] even if it is split across lines until `]`
 *  Example:
 *    include::parts/intro.adoc[lines=2;5.
 *    .6]
 *  -> include::parts/intro.adoc[lines=2;5..6]
 */
function joinBrokenIncludeMacros(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Looks like an include line but has no closing ] -> concatenate until we find ]
    if (/^[ \t\uFEFF]*include::/i.test(line) && !line.includes("]")) {
      let buf = line;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? "";
        // Concatenate naively (ignore inline comments etc.; strip whitespace)
        buf += next.trim();
        if (buf.includes("]")) break;
        j++;
      }
      out.push(buf);
      i = j; // consumed up to here
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

  // Example: leveloffset=+1, lines=2;5..6, tags=public;internal, opts=optional
  // Note: lines can also contain ';', so a naive split(/[;,]/) will break.
  // Approach: capture only key=value pairs (value continues until the next key=)
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
 * Convert a string like "lines=2;5..6,leveloffset=+1" into:
 * [{key:"lines",val:"2;5..6"}, {key:"leveloffset",val:"+1"}]
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

    // Remove only trailing separators from "..., key=VALUE,"
    val = val.replace(/[,;]+$/, "").trim();
    // Remove only leading separators from malformed cases like "key=,VALUE"
    val = val.replace(/^[,;]+\s*/, "");

    res.push({ key: cur.key, val });
  }
  return res;
}

function applyIncludeOptionsBeforeExpand(text: string, opts: IncludeOpts): string {
  let out = text;

  // lines (based on original file line numbers)
  if (opts.lines) {
    out = pickLines(out, opts.lines);
  }

  // tag/tags (based on original file tag:: / end:: blocks)
  if (opts.tag) {
    out = pickTags(out, new Set([opts.tag]));
  } else if (opts.tags && opts.tags.length > 0) {
    out = pickTags(out, new Set(opts.tags));
  }

  // indent (prefix each non-empty line with spaces)
  if (typeof opts.indent === "number" && !Number.isNaN(opts.indent) && opts.indent > 0) {
    const pad = " ".repeat(opts.indent);
    out = out
      .split(/\r?\n/)
      .map((l) => (l.length ? pad + l : l))
      .join("\n");
  }

  return out;
}

/** Parse lines=2;5..6 and pick lines (1-based, inclusive) */
/** Parse lines=2;5..6 and pick lines (1-based, inclusive) */
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

  // ---- Insert blank lines at boundaries of non-contiguous picks to separate blocks ----
  const out: string[] = [];
  let prevPickedLineNo: number | null = null;

  for (let i = 0; i < linesArr.length; i++) {
    const lineNo = i + 1; // 1-based
    if (!picked.has(lineNo)) continue;

    const line = linesArr[i];
    if (line == null) continue; // fully exclude undefined/null

    // Jump to a non-contiguous picked line -> insert a blank line
    if (prevPickedLineNo !== null && lineNo !== prevPickedLineNo + 1) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    }

    // Prevent heading lines from appearing in the middle of a paragraph
    if (/^\s*=+\s+/.test(line)) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    }

    out.push(line);
    prevPickedLineNo = lineNo;
  }

  return out.join("\n");
}

/**
 * Extract only the contents of the requested tags from tag::name[] .. end::name[] blocks
 * - e.g. tag::public[] (common Asciidoctor tag format)
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
      // Always close, even if things are mismatched
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
 *  - Shift AsciiDoc "=" headings by +N / -N
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

    // AsciiDoc can't have fewer than 1 '=', so clamp to 1
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
