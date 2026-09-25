// ── Printable chord chart ────────────────────────────────────────────────────
// Builds a standalone HTML page (chords over lyrics, monospace so alignment
// survives) that the Rust open_print_view command opens in the default
// browser, which pops its print dialog straight away.

import { isChordLine } from "./music";

export interface PrintChart {
  title: string;
  artist: string;
  /** Concert key the song sounds in. */
  key: string;
  /** Output capo (0 = none). */
  capo: number;
  /** Key of the printed chord shapes (= key when capo is 0). */
  shapesKey: string;
  /** Chart text already transposed to shapesKey. */
  chart: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildPrintHtml(p: PrintChart): string {
  // Group into sections so a section never splits across a page break.
  const sections: string[][] = [[]];
  // Blank runs (UG uses 2–3 between sections) would waste paper — sections
  // already get their own spacing, so drop them.
  const lines = p.chart.replace(/\r/g, "").replace(/\s+$/, "").split("\n");
  for (const line of lines.filter(l => l.trim())) {
    if (/^\s*\[[^\]]+\]\s*$/.test(line) && sections[sections.length - 1].length) sections.push([]);
    sections[sections.length - 1].push(line);
  }

  const body = sections.map(lines => {
    const html = lines.map(line => {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (header) return `<div class="sec">${esc(header[1])}</div>`;
      if (isChordLine(line)) return `<div class="ch">${esc(line) || "&nbsp;"}</div>`;
      return `<div class="ly">${esc(line)}</div>`;
    }).join("");
    return `<section>${html}</section>`;
  }).join("");

  const keyLine = p.capo
    ? `Key: <b>${esc(p.key)}</b> &nbsp;·&nbsp; <b>Capo ${p.capo}</b> — chords shown as ${esc(p.shapesKey)} shapes`
    : p.key ? `Key: <b>${esc(p.key)}</b>` : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(p.title)}${p.key ? ` - ${esc(p.key)}` : ""}${p.capo ? ` (Capo ${p.capo})` : ""}</title>
<style>
  @page { size: letter; margin: 0.6in 0.6in 0.7in; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font-family: -apple-system, "Helvetica Neue", Helvetica, sans-serif;
         color: #111; background: #fff; }
  header { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 14px; }
  h1 { margin: 0; font-size: 22pt; line-height: 1.15; }
  .artist { font-size: 12pt; color: #444; margin-top: 2px; }
  .key { font-size: 11pt; margin-top: 6px; }
  .chart { font-family: Menlo, "SF Mono", Consolas, monospace; font-size: 10.5pt; line-height: 1.3; }
  section { break-inside: avoid; page-break-inside: avoid; margin-bottom: 10px; }
  .sec { font-family: -apple-system, "Helvetica Neue", sans-serif; font-weight: 700; font-size: 11pt;
         text-transform: uppercase; letter-spacing: .04em; margin: 6px 0 2px; }
  .ch, .ly { white-space: pre; }
  .ch { font-weight: 700; color: #0b4fa8; }
  .toolbar { position: fixed; top: 12px; right: 12px; }
  .toolbar button { font-size: 14px; padding: 6px 14px; cursor: pointer; }
  @media print {
    body { padding: 0; }
    .toolbar { display: none; }
    .ch { color: #000; }
  }
</style></head>
<body>
  <div class="toolbar"><button onclick="window.print()">Print</button></div>
  <header>
    <h1>${esc(p.title || "Untitled")}</h1>
    ${p.artist ? `<div class="artist">${esc(p.artist)}</div>` : ""}
    ${keyLine ? `<div class="key">${keyLine}</div>` : ""}
  </header>
  <div class="chart">${body}</div>
  <script>window.addEventListener("load", () => setTimeout(() => window.print(), 300));</script>
</body></html>`;
}
