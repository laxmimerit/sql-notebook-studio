// Exports a notebook with its results to HTML, PDF (headless Edge/Chrome) or Markdown.

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { marked } from 'marked';
import { AI_MIME, RESULT_MIME, type AiPayload, type Cell, type ResultPayload, type StatementResult } from '../../shared/protocol';
import { AI_LANGUAGE } from '../notebook/serializer';

interface Block {
  kind: 'md' | 'sql' | 'ai';
  source: string;
  results?: ResultPayload;
  ai: AiPayload[];
}

function blocks(nb: vscode.NotebookDocument): Block[] {
  return nb.getCells().map((cell) => {
    const kind: Block['kind'] = cell.kind === vscode.NotebookCellKind.Markup ? 'md' : cell.document.languageId === AI_LANGUAGE ? 'ai' : 'sql';
    const b: Block = { kind, source: cell.document.getText(), ai: [] };
    for (const o of cell.outputs) {
      for (const item of o.items) {
        try {
          const json = JSON.parse(new TextDecoder().decode(item.data));
          if (item.mime === RESULT_MIME) b.results = json;
          else if (item.mime === AI_MIME) b.ai.push(json);
        } catch {
          /* ignore */
        }
      }
    }
    return b;
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function cellText(v: Cell): string {
  if (v === null) return 'NULL';
  if (typeof v === 'object') return '$bin' in (v as object) ? `0x${(v as any).$bin.toUpperCase()}` : JSON.stringify(v);
  return String(v);
}

const KW = /\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|AS|AND|OR|NOT|IN|IS|NULL|LIKE|BETWEEN|CASE|WHEN|THEN|ELSE|END|WITH|UNION|ALL|DISTINCT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|VIEW|INDEX|DROP|ALTER|PRIMARY|KEY|FOREIGN|REFERENCES|DESC|ASC|COUNT|SUM|AVG|MIN|MAX|OVER|PARTITION BY|TOP)\b/gi;

function highlight(sql: string): string {
  // Strings and comments first, then keywords outside them.
  return sql
    .split(/('(?:[^']|'')*'|--[^\n]*)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part.startsWith('--') ? `<span class="c">${esc(part)}</span>` : `<span class="s">${esc(part)}</span>`;
      return esc(part).replace(KW, '<span class="k">$&</span>');
    })
    .join('');
}

function tableHtml(r: StatementResult, maxRows: number): string {
  const rows = r.rows.slice(0, maxRows);
  const more = r.rows.length - rows.length;
  const head = r.columns.map((c) => `<th class="${c.kind === 'number' ? 'n' : ''}">${esc(c.name)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((v, i) => `<td class="${v === null ? 'null' : r.columns[i].kind === 'number' ? 'n' : ''}">${esc(cellText(v))}</td>`).join('')}</tr>`)
    .join('');
  const note = `${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? '' : 's'}${r.truncated ? ' (limit reached)' : ''}${more > 0 ? ` · first ${rows.length.toLocaleString()} shown` : ''}`;
  return `<div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div><div class="note">${note}</div>`;
}

export function toHtml(title: string, bs: Block[], maxRows: number, chartJs: string): string {
  let charts = 0;
  const parts = bs.map((b) => {
    if (b.kind === 'md') return `<section class="md">${marked.parse(b.source, { async: false })}</section>`;
    const out: string[] = [];
    if (b.kind === 'ai') out.push(`<div class="prompt"><span>AI</span>${esc(b.source)}</div>`);
    else out.push(`<pre class="sql">${highlight(b.source)}</pre>`);
    const p = b.results;
    if (p) {
      p.results.forEach((r, i) => {
        if (p.results.length > 1) out.push(`<div class="stmt">Statement ${i + 1}</div>`);
        if (!r.hasRows) out.push(`<div class="note ok">✓ ${r.affected !== undefined ? `${r.affected} rows affected` : 'Done'}</div>`);
        else if (i === 0 && p.view === 'chart' && p.chart) {
          charts++;
          const data = { config: p.chart, columns: r.columns.map((c) => c.name), rows: r.rows.slice(0, 5000) };
          out.push(`<div class="chartbox"><canvas data-chart="${esc(JSON.stringify(data))}"></canvas></div>`);
        } else out.push(tableHtml(r, maxRows));
      });
      if (p.error) out.push(`<pre class="err">${esc(p.error.message)}</pre>`);
    }
    for (const a of b.ai) if (a.status === 'done') out.push(`<div class="ai">${marked.parse(a.markdown, { async: false })}</div>`);
    return `<section class="cell">${out.join('\n')}</section>`;
  });

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --fg:#1f2328; --muted:#656d76; --bg:#ffffff; --code:#f6f8fa; --b:#d8dee4; --k:#0550ae; --s:#0a3069; --c:#6e7781; --accent:#8250df; --err:#cf222e; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --muted:#8d96a0; --bg:#0d1117; --code:#161b22; --b:#30363d; --k:#79c0ff; --s:#a5d6ff; --c:#8b949e; --accent:#bc8cff; --err:#ff7b72; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 40px 24px 64px; }
h1.title { font-size: 13px; font-weight: 600; color: var(--muted); letter-spacing: .02em; margin: 0 0 24px; text-transform: uppercase; }
section { margin: 0 0 22px; }
.md h1, .md h2, .md h3 { line-height: 1.25; margin: 18px 0 8px; }
.md code, .ai code { font: 12.5px ui-monospace, Consolas, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; }
pre { margin: 0; }
pre.sql { font: 12.5px/1.55 ui-monospace, Consolas, monospace; background: var(--code); border: 1px solid var(--b); border-radius: 6px; padding: 12px 14px; overflow: auto; white-space: pre-wrap; }
.k { color: var(--k); font-weight: 600; } .s { color: var(--s); } .c { color: var(--c); font-style: italic; }
.prompt { border-left: 3px solid var(--accent); padding: 6px 12px; background: var(--code); border-radius: 0 6px 6px 0; }
.prompt span { font-size: 11px; font-weight: 700; color: var(--accent); margin-right: 8px; }
.tbl { margin-top: 10px; overflow: auto; max-height: 520px; border: 1px solid var(--b); border-radius: 6px; }
table { border-collapse: collapse; width: 100%; font: 12.5px ui-monospace, Consolas, monospace; }
th, td { padding: 5px 10px; border-bottom: 1px solid var(--b); text-align: left; white-space: nowrap; }
th { position: sticky; top: 0; background: var(--code); font-family: -apple-system, "Segoe UI", system-ui, sans-serif; font-weight: 600; }
td.n, th.n { text-align: right; } td.null { color: var(--muted); font-style: italic; }
tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--code) 55%, transparent); }
.note { font-size: 12px; color: var(--muted); margin-top: 6px; } .note.ok { color: inherit; margin-top: 10px; }
.stmt { font-size: 12px; font-weight: 600; color: var(--muted); margin-top: 12px; }
.err { color: var(--err); margin-top: 10px; white-space: pre-wrap; font: 12.5px ui-monospace, Consolas, monospace; }
.ai { margin-top: 10px; border: 1px solid var(--b); border-left: 3px solid var(--accent); border-radius: 6px; padding: 4px 14px; }
.chartbox { position: relative; height: 340px; margin-top: 10px; border: 1px solid var(--b); border-radius: 6px; padding: 10px; }
footer { margin-top: 40px; font-size: 12px; color: var(--muted); }
@media print { main { padding: 0; } .tbl { max-height: none; overflow: visible; } th { position: static; } section { break-inside: avoid-page; } }
</style></head>
<body><main>
<h1 class="title">${esc(title)}</h1>
${parts.join('\n')}
<footer>Exported from SQL Notebook · ${new Date().toLocaleString()}</footer>
</main>
${charts ? `<script>${chartJs}</script><script>${CHART_BOOT}</script>` : ''}
</body></html>`;
}

const CHART_BOOT = `
(function(){
  var colors=['#3794ff','#d18616','#2da44e','#8250df','#cf222e','#bf8700'];
  document.querySelectorAll('canvas[data-chart]').forEach(function(cv){
    var d=JSON.parse(cv.getAttribute('data-chart')); var c=d.config;
    var xi=d.columns.indexOf(c.x); var labels=d.rows.map(function(r){return r[xi]===null?'NULL':String(r[xi]);});
    var ds=c.y.map(function(name,k){var yi=d.columns.indexOf(name); var vals=d.rows.map(function(r){var v=r[yi];return v===null?null:Number(v);});
      if(c.type==='pie') return {label:name,data:vals,backgroundColor:vals.map(function(_,j){return colors[j%colors.length];})};
      if(c.type==='scatter') return {label:name,data:d.rows.map(function(r,j){return {x:Number(r[xi]),y:vals[j]};}),backgroundColor:colors[k%colors.length]};
      return {label:name,data:vals,backgroundColor:colors[k%colors.length]+(c.type==='area'?'40':'cc'),borderColor:colors[k%colors.length],borderWidth:c.type==='bar'?0:2,fill:c.type==='area',tension:.25,pointRadius:vals.length>60?0:2};});
    if(c.type==='pie') ds=ds.slice(0,1);
    new Chart(cv,{type:c.type==='area'?'line':c.type==='pie'?'doughnut':c.type,data:{labels:labels,datasets:ds},
      options:{animation:false,responsive:true,maintainAspectRatio:false,indexAxis:c.horizontal?'y':'x',
        scales:c.type==='pie'?undefined:{x:{stacked:!!c.stacked,type:c.type==='scatter'?'linear':undefined},y:{stacked:!!c.stacked,beginAtZero:c.type!=='scatter'}},
        plugins:{legend:{display:c.type==='pie'||ds.length>1}}}});
  });
})();`;

export function toMarkdown(bs: Block[], maxRows: number): string {
  const out: string[] = [];
  const md = (v: Cell) => cellText(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const b of bs) {
    if (b.kind === 'md') {
      out.push(b.source.trim(), '');
      continue;
    }
    if (b.kind === 'ai') out.push(`> **AI:** ${b.source.trim()}`, '');
    else out.push('```sql', b.source.trim(), '```', '');
    for (const r of b.results?.results ?? []) {
      if (!r.hasRows) {
        out.push(`✓ ${r.affected !== undefined ? `${r.affected} rows affected` : 'Done'}`, '');
        continue;
      }
      const rows = r.rows.slice(0, maxRows);
      out.push(`| ${r.columns.map((c) => c.name.replace(/\|/g, '\\|')).join(' | ')} |`);
      out.push(`| ${r.columns.map((c) => (c.kind === 'number' ? '---:' : '---')).join(' | ')} |`);
      for (const row of rows) out.push(`| ${row.map(md).join(' | ')} |`);
      if (r.rows.length > rows.length) out.push('', `_${r.rows.length.toLocaleString()} rows, first ${rows.length} shown._`);
      out.push('');
    }
    if (b.results?.error) out.push('```text', b.results.error.message, '```', '');
    for (const a of b.ai) if (a.status === 'done') out.push(a.markdown.trim(), '');
  }
  return out.join('\n');
}

function browserPath(): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((p) => existsSync(p));
}

export async function exportNotebook(ctx: vscode.ExtensionContext, format: 'html' | 'pdf' | 'md') {
  const nb = vscode.window.activeNotebookEditor?.notebook;
  if (!nb || nb.notebookType !== 'sqlnb') {
    void vscode.window.showInformationMessage('Open a SQL notebook to export it.');
    return;
  }
  const maxRows = vscode.workspace.getConfiguration('sqlNotebook').get<number>('export.maxRows', 500);
  const base = nb.isUntitled ? 'notebook' : path.basename(nb.uri.fsPath).replace(/\.sqlnb$/i, '');
  const title = base;
  const ext = format === 'md' ? 'md' : format;
  const defaultUri = nb.isUntitled ? undefined : vscode.Uri.file(path.join(path.dirname(nb.uri.fsPath), `${base}.${ext}`));
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: format === 'md' ? { Markdown: ['md'] } : format === 'pdf' ? { PDF: ['pdf'] } : { HTML: ['html'] },
    title: `Export as ${format.toUpperCase()}`,
  });
  if (!target) return;
  const bs = blocks(nb);
  if (format === 'md') {
    writeFileSync(target.fsPath, toMarkdown(bs, maxRows), 'utf8');
  } else {
    const chartJs = readFileSync(path.join(ctx.extensionPath, 'dist', 'media', 'chart.umd.js'), 'utf8');
    const html = toHtml(title, bs, maxRows, chartJs);
    if (format === 'html') writeFileSync(target.fsPath, html, 'utf8');
    else {
      const browser = browserPath();
      const tmp = path.join(os.tmpdir(), `sqlnb-${Date.now()}.html`);
      writeFileSync(tmp, html, 'utf8');
      if (!browser) {
        void vscode.window.showWarningMessage('No Edge or Chrome found for PDF. Opening HTML instead: print it to PDF from the browser.');
        void vscode.env.openExternal(vscode.Uri.file(tmp));
        return;
      }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Exporting PDF…' }, () =>
        new Promise<void>((resolve, reject) => {
          execFile(
            browser,
            ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--run-all-compositor-stages-before-draw', '--virtual-time-budget=4000', `--print-to-pdf=${target.fsPath}`, vscode.Uri.file(tmp).toString()],
            { timeout: 60000 },
            (err) => (err && !existsSync(target.fsPath) ? reject(err) : resolve()),
          );
        }),
      );
    }
  }
  const open = await vscode.window.showInformationMessage(`Exported ${path.basename(target.fsPath)}`, 'Open');
  if (open) {
    if (format === 'md') await vscode.window.showTextDocument(target);
    else await vscode.env.openExternal(target);
  }
}
