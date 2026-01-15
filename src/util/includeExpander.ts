import type { App } from "obsidian";
import { normalizePath, TFile } from "obsidian";

export type IncludeExpandOptions = {
  maxDepth?: number;
  insertMarkers?: boolean;
};

export type ExpandResult = {
  text: string;
  deps: string[]; // vault内パス
};

function stripQuotes(s: string): string {
  const t = (s ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export async function expandIncludes(
  app: App,
  text: string,
  baseFile: TFile,
  opts: IncludeExpandOptions = {}
): Promise<ExpandResult> {
  const maxDepth = opts.maxDepth ?? 20;
  const insertMarkers = opts.insertMarkers ?? true;

  const visited = new Set<string>();
  visited.add(baseFile.path);

  const deps = new Set<string>();
  deps.add(baseFile.path);

  async function expandRec(src: string, currentFile: TFile, depth: number): Promise<string> {
    src = src.replace(/\uFEFF/g, "");


    if (depth > maxDepth) {
      return `${src}\n// [include] maxDepth(${maxDepth}) reached at: ${currentFile.path}\n`;
    }

    // ✅ 先頭空白OK / 行末コメントOK
    // include::path[] / include::path[attrs]
    const re = /^[ \t\uFEFF]*include::\s*(.+?)\[(.*?)\][ \t]*(?:(\/\/|#|;).*)?$/gm;

    let out = "";
    let lastIndex = 0;

    for (;;) {
      const m = re.exec(src);
      if (!m) break;

      out += src.slice(lastIndex, m.index);

      const rawTarget = stripQuotes(m[1] ?? "");
      const resolvedPath = resolveVaultPath(currentFile.path, rawTarget);

      // ★デバッグ：まず “マッチしてるか” と “解決先” を見る
      console.log("[include] matched:", m[0]);
      console.log("[include] target:", rawTarget, "resolved:", resolvedPath);

      const af = app.vault.getAbstractFileByPath(resolvedPath);
      if (!af || !(af instanceof TFile)) {
        out += `\n// [include] NOT FOUND: ${rawTarget}  (resolved: ${resolvedPath})\n`;
        lastIndex = re.lastIndex;
        continue;
      }

      deps.add(af.path);
      
      if (visited.has(af.path)) {
        out += `\n// [include] CYCLE DETECTED: ${af.path}\n`;
        lastIndex = re.lastIndex;
        continue;
      }

      visited.add(af.path);

      let included = await app.vault.read(af);
      included = await expandRec(included, af, depth + 1);

      if (insertMarkers) {
        out += `\n// --- include begin: ${af.path} ---\n`;
        out += included;
        out += `\n// --- include end: ${af.path} ---\n`;
      } else {
        out += included;
      }

      lastIndex = re.lastIndex;
    }

    out += src.slice(lastIndex);
    return out;
  }

  const expanded = await expandRec(text, baseFile, 0);
  return { text: expanded, deps: Array.from(deps) };

}

function resolveVaultPath(currentFilePath: string, target: string): string {
  let t = (target ?? "").replace(/\\/g, "/").trim();

  // 絶対（vault ルート）
  if (t.startsWith("/")) {
    t = t.slice(1);
  } else {
    // 相対
    const baseDir = currentFilePath.includes("/")
      ? currentFilePath.slice(0, currentFilePath.lastIndexOf("/"))
      : "";
    t = baseDir ? `${baseDir}/${t}` : t;
  }

  // 拡張子省略 → .adoc を補完
  if (!/\.[a-zA-Z0-9]+$/.test(t)) {
    t += ".adoc";
  }

  return normalizePath(t);
}