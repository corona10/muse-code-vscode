// Renders adversarial and ordinary Markdown through src/webview-ui/markdown.ts and
// asserts that generated anchors never pick up attributes from the input text.
// Run: npm run test:markdown
import { transform } from "esbuild";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = readFileSync(new URL("../src/webview-ui/markdown.ts", import.meta.url), "utf8");
const { code } = await transform(src, { loader: "ts", format: "esm" });
const outDir = mkdtempSync(join(tmpdir(), "markdown-check-"));
const outFile = join(outDir, "markdown.mjs");
writeFileSync(outFile, code);
const { renderMarkdown } = await import(pathToFileURL(outFile).href);

const ALLOWED = { a: new Set(["href", "class", "data-file"]) };
const TAG_RE = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
// Consumes quoted values whole, so "=" inside an href is never read as a new attribute.
const ATTR_RE = /([^\s=\/"'>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

function attributes(html) {
  const found = [];
  for (const m of html.matchAll(TAG_RE)) {
    const [, tag, rest] = m;
    for (const a of rest.matchAll(ATTR_RE)) {
      found.push({ tag, name: a[1].toLowerCase(), value: a[2] ?? "" });
    }
  }
  return found;
}

const cases = [
  // links whose URL contains another URL, quotes, angle brackets, or emphasis
  // markers must stay plain hrefs: one anchor, no extra attributes, no tags
  // inside the attribute value
  { input: "[x](https://a.example/(https://b.example/style=color:red))", expectHref: true },
  { input: "[x](https://a.example/\"style=\"color:red)", expectHref: true },
  { input: "see https://z.example/\" style=\"x [y](https://q.example/)", expectHref: true },
  { input: "[x](https://a.example/<b>)", expectHref: true },
  { input: "[x](https://e.example/*evil*)", expectHref: true },
  { input: "[x](https://e.example/__evil__/~~x~~)", expectHref: true },
  { input: "https://e.example/_a_b_ and *[x](https://e.example/y)*", expectHref: true },
  // ordinary rendering must survive
  { input: "read [docs](https://example.com/docs) now", expect: '<a href="https://example.com/docs">docs</a>' },
  { input: "go to https://example.com/path?q=1 today", expect: '<a href="https://example.com/path?q=1">https://example.com/path?q=1</a>' },
  { input: "*see [x](https://e.example/) here*", expect: '<em>see <a href="https://e.example/">x</a> here</em>' },
  { input: "**bold** `code <b>` @src/file.ts#L1-2", expect: 'data-file="src/file.ts#L1-2"' },
];

let failures = 0;
for (const c of cases) {
  const html = renderMarkdown(c.input);
  const attrs = attributes(html);
  const bad = attrs.filter(({ tag, name }) => !(ALLOWED[tag] ?? new Set()).has(name));
  // A raw "<" inside an attribute value means a later pass rewrote a generated tag.
  const tagInAttr = attrs.filter(({ value }) => value.includes("<"));
  const anchors = attrs.filter(({ tag, name }) => tag === "a" && name === "href");
  const noHref = c.expectHref && anchors.length === 0;
  const missing = c.expect && !html.includes(c.expect);
  if (bad.length || tagInAttr.length || noHref || missing) {
    failures++;
    const why = bad.length ? "unexpected attributes: " + JSON.stringify(bad)
      : tagInAttr.length ? "tag inside attribute value: " + JSON.stringify(tagInAttr)
      : noHref ? "expected an anchor with href" : "expected fragment missing";
    console.error(`FAIL ${JSON.stringify(c.input)}\n  html: ${html}\n  ${why}`);
  }
}
if (failures) { console.error(`${failures} failing case(s)`); process.exit(1); }
console.log(`ok: ${cases.length} cases, anchors carry only href/class/data-file`);
