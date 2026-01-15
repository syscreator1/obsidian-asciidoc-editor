function renderIncludeWarning(line: string): string | null {
  if (line.startsWith("// [include]")) {
    return `<div class="adoc-include-warn">${line.replace("// [include]", "").trim()}</div>`;
  }
  return null;
}

export function adocToHtml(src: string): string {
  const lines = src.split(/\r?\n/);

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  let html: string[] = [];
  let inCode = false;

  for (const line of lines) {
    const warn = renderIncludeWarning(line);
    if (warn) {
        html.push(warn);
        continue;
    }

    if (line.trim() === "----") {
      inCode = !inCode;
      html.push(inCode ? "<pre><code>" : "</code></pre>");
      continue;
    }

    if (inCode) {
      html.push(esc(line) + "\n");
      continue;
    }

    const m = line.match(/^(=+)\s+(.*)$/);
    if (m && m[1] && m[2] !== undefined) {
      const level = Math.min(m[1].length, 6);
      html.push(`<h${level}>${esc(m[2])}</h${level}>`);
      continue;
    }

    const ul = line.match(/^\*\s+(.*)$/);
    if (ul && ul[1] !== undefined) {
      html.push(`<div class="adoc-li">• ${esc(ul[1])}</div>`);
      continue;
    }

    if (line.trim() === "") {
      html.push(`<div class="adoc-sp"></div>`);
      continue;
    }

    html.push(`<p>${esc(line)}</p>`);
  }

  return html.join("\n");
}