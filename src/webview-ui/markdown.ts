/** Small, dependency-free Markdown → HTML renderer. Escapes everything first, so it is XSS-safe by construction. */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string): string {
  let out = "";
  let i = 0;
  // code spans first so their contents are never styled
  const parts = s.split(/(`+[^`]*`+)/g);
  for (const p of parts) {
    if (/^`+[^`]*`+$/.test(p)) {
      out += `<code>${escapeHtml(p.replace(/^`+|`+$/g, ""))}</code>`;
      continue;
    }
    let t = escapeHtml(p);
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>)]+)/g, '$1<a href="$2">$2</a>');
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    // @path#L1-2 mentions become clickable file links
    t = t.replace(/(^|\s)@([\w./-]+(?:#L\d+(?:-\d+)?)?)/g, '$1<a class="file-link" data-file="$2" href="#">@$2</a>');
    out += t;
  }
  i++;
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      html.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      flush();
      const close = fence[1];
      const lang = fence[2];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) buf.push(lines[i++]);
      i++;
      const code = buf.join("\n");
      html.push(`<div class="codeblock"><div class="codeblock-head"><span>${escapeHtml(lang || "text")}</span><button class="icon-btn copy-btn" title="Copy" data-copy="${escapeHtml(code)}"><i class="codicon codicon-copy"></i></button></div><pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre></div>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      html.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      html.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      html.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const baseIndent = li[1].length;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && m[1].length === baseIndent && /\d/.test(m[2]) === ordered) {
          let body = m[3];
          i++;
          // continuation / nested lines
          const nested: string[] = [];
          while (i < lines.length && lines[i].trim() !== "" && !(lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+/)?.[1].length === baseIndent)) {
            if (/^\s+/.test(lines[i]) || !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])) nested.push(lines[i].replace(new RegExp(`^\\s{0,${baseIndent + 2}}`), ""));
            else break;
            i++;
          }
          const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
          if (task) body = `<input type="checkbox" disabled ${task[1] !== " " ? "checked" : ""}> ${task[2]}`;
          items.push(`<li>${task ? body.replace(/^(<input[^>]*>) (.*)$/, (_, a, b) => a + " " + inline(b)) : inline(body)}${nested.length ? renderMarkdown(nested.join("\n")) : ""}</li>`);
        } else break;
      }
      html.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return html.join("\n");
}
