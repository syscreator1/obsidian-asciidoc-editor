import { App, TFile } from "obsidian";
import * as path from "path";

/**
 * AsciiDoc style inside PlantUML block
 *   include::./Entity/foo.adoc[]
 */
const RE_ADOC_INCLUDE = /^\s*include::\s*([^\[]+?)\s*\[.*?\]\s*$/gim;

/**
 * PlantUML native include
 *   !include ./foo.puml
 *   !include_once ./foo.puml
 *   !include_many ./foo.puml
 *   !include "path with spaces.puml"
 */
const RE_PUML_INCLUDE =
  /^\s*!(include|include_once|include_many)\s+(.+?)\s*$/gim;

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function isRemoteLike(p: string): boolean {
  const t = (p ?? "").trim();
  return /^https?:\/\//i.test(t) || /^<https?:\/\//i.test(t);
}

export async function expandPlantumlIncludes(params: {
  app: App;
  baseFile: TFile;
  text: string;
  deps: Set<string>;
  depth?: number;
  maxDepth?: number;

  // ★ !include_once のための「展開済み」管理（レンダー全体で共有）
  seenOnce?: Set<string>;
}): Promise<string> {
  const { app, baseFile, deps } = params;
  const depth = params.depth ?? 0;
  const maxDepth = params.maxDepth ?? 20;
  const seenOnce = params.seenOnce ?? new Set<string>();

  if (depth > maxDepth) {
    throw new Error(`PlantUML include nesting too deep (>${maxDepth})`);
  }

  const baseDir = path.posix.dirname(baseFile.path);

  // 2種類の include を「同じやり方」で展開するための共通関数
  const expandOne = async (incPathRaw: string, mode: "normal" | "once" | "many"): Promise<string> => {
    let p = stripQuotes(incPathRaw);

    // <...> で囲まれてる場合がある（URL表現など）
    if (p.startsWith("<") && p.endsWith(">")) p = p.slice(1, -1).trim();

    // リモートはここでは扱わない（PlantUML に任せる）
    if (isRemoteLike(p)) return "";

    const resolved = path.posix.normalize(path.posix.join(baseDir, p));
    const af = app.vault.getAbstractFileByPath(resolved);
    if (!(af instanceof TFile)) {
      throw new Error(`Included file not found: ${resolved}`);
    }

    deps.add(af.path);

    if (mode === "once") {
      if (seenOnce.has(af.path)) return "";
      seenOnce.add(af.path);
    }

    const includedText = await app.vault.read(af);

    // ★拡張子で扱いを変える
    const ext = (af.extension ?? "").toLowerCase();

    // .adoc の場合：AsciiDoc include:: を展開してから戻す
    // ※ ここでは “PlantUML ブロック内部用” なので、ヘッダ属性などは気にせず include だけ解決する
    if (ext === "adoc") {
      const adocExpanded = await expandAdocIncludesInText({
        app,
        baseFile: af,
        text: includedText,
        deps,
        depth: depth + 1,
        maxDepth,
      });

      // 展開済みテキストに対してさらに PlantUML include を解決（再帰）
      return await expandPlantumlIncludes({
        app,
        baseFile: af,
        text: adocExpanded,
        deps,
        depth: depth + 1,
        maxDepth,
        seenOnce,
      });
    }

    // .puml / .iuml / その他：PlantUML include としてそのまま再帰
    return await expandPlantumlIncludes({
      app,
      baseFile: af,
      text: includedText,
      deps,
      depth: depth + 1,
      maxDepth,
      seenOnce,
    });
  };

  // まずは AsciiDoc include:: を展開
  let out = await replaceAsync(params.text, RE_ADOC_INCLUDE, async (_m0, p1) => {
    return await expandOne(String(p1), "normal");
  });

  // 次に PlantUML !include を展開
  out = await replaceAsync(out, RE_PUML_INCLUDE, async (m0, kind, rest) => {
    const k = String(kind).toLowerCase();
    const rhs = String(rest);

    // 行末コメントがある場合を軽く吸収（; や // はケースバイケースなので控えめに）
    const pathPart = (rhs.split(/\s+\/\/|\s+;/)[0] ?? "").trim();
    if (!pathPart) {
      return m0; // パスが取れないなら展開せずそのまま返す
    }

    if (isRemoteLike(pathPart)) {
      // リモート include は PlantUML に任せる：行をそのまま残す
      return m0;
    }

    const mode = k === "include_once" ? "once" : "normal";
    // include_many は本来ディレクトリ/ワイルドカード等の意味もあるが、
    // ここでは「普通の include と同様に 1ファイル展開」とする（必要なら拡張）
    return await expandOne(pathPart, mode);
  });

  return out;
}

/**
 * JS に標準の async replace がないので自前実装
 */
async function replaceAsync(
  input: string,
  re: RegExp,
  replacer: (...args: any[]) => Promise<string>
): Promise<string> {
  let out = "";
  let lastIndex = 0;

  // matchAll は lastIndex を壊さないので安全
  for (const m of input.matchAll(re)) {
    out += input.slice(lastIndex, m.index);

    // replacer に exec/replace と同じ引数を渡す
    const args = [...m, m.index, input];
    out += await replacer(...args);

    lastIndex = (m.index ?? 0) + m[0].length;
  }

  out += input.slice(lastIndex);
  return out;
}

async function expandAdocIncludesInText(params: {
  app: App;
  baseFile: TFile;
  text: string;
  deps: Set<string>;
  depth: number;
  maxDepth: number;
}): Promise<string> {
  const { app, baseFile, deps, depth, maxDepth } = params;
  if (depth > maxDepth) throw new Error(`AsciiDoc include nesting too deep (>${maxDepth})`);

  const baseDir = path.posix.dirname(baseFile.path);

  // include::path[] を展開（PlantUMLブロック内の簡易版：属性は無視）
  return await replaceAsync(params.text, RE_ADOC_INCLUDE, async (_m0: string, p1: string) => {
    const incRaw = String(p1 ?? "").trim();
    if (!incRaw) return "";

    // URL系は展開しない（必要ならここで throw）
    if (isRemoteLike(incRaw)) return _m0;

    const resolved = path.posix.normalize(path.posix.join(baseDir, incRaw));
    const af = app.vault.getAbstractFileByPath(resolved);
    if (!(af instanceof TFile)) {
      throw new Error(`Included file not found: ${resolved}`);
    }

    deps.add(af.path);

    const includedText = await app.vault.read(af);

    // .adoc include の中にも include があるかもしれないので再帰
    return await expandAdocIncludesInText({
      app,
      baseFile: af,
      text: includedText,
      deps,
      depth: depth + 1,
      maxDepth,
    });
  });
}
