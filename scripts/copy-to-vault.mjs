import fs from "node:fs";
import path from "node:path";

const vaultPluginDir = "E:\\Obsidian\\Plugin開発用\\.obsidian\\plugins\\asciidoc-editor";
const here = process.cwd();

for (const f of ["manifest.json", "styles.css"]) {
  const src = path.join(here, f);
  const dst = path.join(vaultPluginDir, f);
  fs.copyFileSync(src, dst);
  console.log(`[copy] ${src} -> ${dst}`);
}
