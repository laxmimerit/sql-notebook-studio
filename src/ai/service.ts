// AI features: Explain, Optimize, Fix, Explain Result, and AI cells that write SQL.
// Answers stream into the cell's output, under the results.

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ConnectionConfig } from '../db/types';
import { findOutput, outputId, type Kernels } from '../notebook/kernels';
import { SQL_LANGUAGE, isSqlLanguage } from '../notebook/serializer';
import type { SchemaCache } from '../schema/cache';
import { AI_MIME, RESULT_MIME, isSchemaChange, type AiKind, type AiPayload, type ResultPayload } from '../../shared/protocol';
import * as P from './prompts';
import type { AiConfig, Provider } from './models';

type AiModule = typeof import('./models');

const PROVIDERS: { id: Provider; label: string; detail: string; needsKey: boolean }[] = [
  { id: 'openai', label: 'OpenAI', detail: 'GPT models. Needs an API key.', needsKey: true },
  { id: 'anthropic', label: 'Anthropic', detail: 'Claude models. Needs an API key.', needsKey: true },
  { id: 'openrouter', label: 'OpenRouter', detail: 'Hundreds of models with one key.', needsKey: true },
  { id: 'ollama', label: 'Ollama', detail: 'Local models on this computer. No key, nothing leaves your machine.', needsKey: false },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', detail: 'LM Studio, vLLM, LiteLLM, Azure gateways and more.', needsKey: false },
];

export class AiService {
  private mod?: AiModule;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly kernels: Kernels,
    private readonly schema: SchemaCache,
  ) {}

  private load(): AiModule {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.mod ??= require(path.join(this.ctx.extensionPath, 'dist', 'ai.js')) as AiModule;
    return this.mod;
  }

  private keyName(p: Provider) {
    return `sqlNotebook.ai.${p}.key`;
  }

  async config(): Promise<AiConfig> {
    const c = vscode.workspace.getConfiguration('sqlNotebook.ai');
    const provider = c.get<Provider>('provider', 'openai');
    return {
      provider,
      model: c.get<string>('model', '') || this.load().DEFAULT_MODELS[provider],
      baseUrl: c.get<string>('baseUrl', '') || this.load().DEFAULT_BASE_URL[provider],
      apiKey: (await this.ctx.secrets.get(this.keyName(provider))) ?? undefined,
    };
  }

  /** Returns a usable config, or undefined when AI is not set up yet. */
  private async ready(): Promise<AiConfig | undefined> {
    const cfg = await this.config();
    const needsKey = PROVIDERS.find((p) => p.id === cfg.provider)?.needsKey;
    return (needsKey && !cfg.apiKey) || !cfg.model ? undefined : cfg;
  }

  // ---------- Configure (quick picks) ----------

  async configure(): Promise<void> {
    const c = vscode.workspace.getConfiguration('sqlNotebook.ai');
    const current = c.get<Provider>('provider', 'openai');
    const pick = await vscode.window.showQuickPick(
      PROVIDERS.map((p) => ({ label: p.label, detail: p.detail, description: p.id === current ? 'current' : '', id: p.id })),
      { title: 'Configure AI (1/3): provider', placeHolder: 'Choose who runs the model' },
    );
    if (!pick) return;
    const provider = pick.id;
    const info = PROVIDERS.find((p) => p.id === provider)!;
    const mod = this.load();

    let baseUrl = c.get<string>('baseUrl', '');
    if (provider === 'ollama' || provider === 'custom') {
      const v = await vscode.window.showInputBox({
        title: 'Configure AI (2/3): base URL',
        value: baseUrl || mod.DEFAULT_BASE_URL[provider] || 'http://localhost:1234/v1',
        prompt: provider === 'ollama' ? 'Where Ollama runs.' : 'The OpenAI-compatible API root, usually ending in /v1.',
        ignoreFocusOut: true,
      });
      if (v === undefined) return;
      baseUrl = v.trim();
    } else baseUrl = '';

    let apiKey = (await this.ctx.secrets.get(this.keyName(provider))) ?? '';
    if (info.needsKey || provider === 'custom') {
      const v = await vscode.window.showInputBox({
        title: `Configure AI (2/3): ${info.label} API key`,
        password: true,
        placeHolder: apiKey ? 'A key is saved. Press Enter to keep it.' : provider === 'custom' ? 'Optional' : 'Paste your API key',
        prompt: 'Stored in VS Code secure storage. Never written to settings or notebooks.',
        ignoreFocusOut: true,
      });
      if (v === undefined) return;
      if (v.trim()) apiKey = v.trim();
      if (info.needsKey && !apiKey) return;
    }

    const cfg: AiConfig = { provider, model: '', apiKey, baseUrl: baseUrl || undefined };
    let models: string[] = [];
    try {
      models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Loading models…' }, () => mod.listModels(cfg));
    } catch (e) {
      void vscode.window.showWarningMessage(`Could not list models: ${e instanceof Error ? e.message : String(e)}. You can type a model ID.`);
    }
    const currentModel = provider === current ? c.get<string>('model', '') : '';
    const preferred = currentModel || mod.DEFAULT_MODELS[provider];
    const ordered = [...new Set([preferred, ...models].filter(Boolean))];
    const TYPE = '$(edit) Type a model ID…';
    const modelPick = await vscode.window.showQuickPick(
      [...ordered.map((m) => ({ label: m, description: m === preferred ? (m === currentModel ? 'current' : 'recommended') : '' })), { label: TYPE }],
      { title: 'Configure AI (3/3): model', placeHolder: 'Type to filter', matchOnDescription: true },
    );
    if (!modelPick) return;
    let model = modelPick.label;
    if (model === TYPE) {
      const v = await vscode.window.showInputBox({ title: 'Model ID', value: preferred, ignoreFocusOut: true });
      if (!v) return;
      model = v.trim();
    }

    await c.update('provider', provider, vscode.ConfigurationTarget.Global);
    await c.update('model', model, vscode.ConfigurationTarget.Global);
    await c.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    if (apiKey) await this.ctx.secrets.store(this.keyName(provider), apiKey);

    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Testing ${info.label} · ${model}…` }, async () => {
        let text = '';
        for await (const t of mod.streamText({ ...cfg, model }, 'Reply with the single word OK.', 'Say OK')) {
          text += t;
          if (text.length > 40) break;
        }
      });
      void vscode.window.showInformationMessage(`AI is ready: ${info.label} · ${model}`);
    } catch (e) {
      void vscode.window.showErrorMessage(`AI test failed: ${e instanceof Error ? e.message : String(e)}`, 'Configure AI').then((x) => x && this.configure());
    }
  }

  // ---------- Streaming into a cell ----------

  private async streamInto(
    nb: vscode.NotebookDocument,
    cell: vscode.NotebookCell,
    kind: AiKind,
    build: () => Promise<{ system: string; user: string }>,
    exec?: vscode.NotebookCellExecution,
  ): Promise<AiPayload | undefined> {
    const cfg = await this.ready();
    if (!cfg) {
      // Shown in the cell, with a Configure AI button, so Run All never waits on a pop-up.
      const setup = async (x: vscode.NotebookCellExecution) => {
        const keep = kind === 'generate' ? [] : cell.outputs.filter((o) => !o.items.some((i) => i.mime === AI_MIME));
        const payload: AiPayload = { v: 1, id: outputId(), kind, status: 'error', markdown: 'AI is not set up yet. Choose a provider: OpenAI, Anthropic, OpenRouter, Ollama or your own API.', model: '' };
        await x.replaceOutput([...keep, new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json(payload, AI_MIME)], { sqlnbId: payload.id })]);
        return undefined;
      };
      return exec ? setup(exec) : this.kernels.withExecution(nb, cell, setup);
    }
    const run = async (x: vscode.NotebookCellExecution) => {
      const keep = kind === 'generate' ? [] : cell.outputs.filter((o) => !o.items.some((i) => i.mime === AI_MIME));
      const payload: AiPayload = { v: 1, id: outputId(), kind, status: 'streaming', markdown: '', model: `${cfg.provider} · ${cfg.model}` };
      const out = new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json(payload, AI_MIME)], { sqlnbId: payload.id });
      await x.replaceOutput([...keep, out]);
      const abort = new AbortController();
      const sub = x.token.onCancellationRequested(() => abort.abort());
      let last = 0;
      const push = (force = false) => {
        const now = Date.now();
        if (!force && now - last < 100) return;
        last = now;
        void x.replaceOutputItems(vscode.NotebookCellOutputItem.json(payload, AI_MIME), out);
      };
      try {
        const { system, user } = await build();
        let acc = '';
        for await (const t of this.load().streamText(cfg, system, user, abort.signal)) {
          acc += t;
          payload.markdown = P.stripThinking(acc);
          push();
        }
        payload.status = 'done';
        if (kind !== 'explain' && kind !== 'result') payload.sql = P.extractSql(payload.markdown);
      } catch (e) {
        payload.status = 'error';
        payload.markdown = abort.signal.aborted ? 'Stopped.' : `**AI error:** ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        sub.dispose();
        push(true);
      }
      return payload;
    };
    return exec ? run(exec) : this.kernels.withExecution(nb, cell, run);
  }

  private find(outputId: string) {
    return findOutput(outputId);
  }

  private resultOf(cell: vscode.NotebookCell): ResultPayload | undefined {
    for (const o of cell.outputs) {
      const item = o.items.find((i) => i.mime === RESULT_MIME);
      if (item) return JSON.parse(new TextDecoder().decode(item.data)) as ResultPayload;
    }
    return undefined;
  }

  private target(cell?: vscode.NotebookCell) {
    const editor = vscode.window.activeNotebookEditor;
    const c = cell ?? (editor ? editor.notebook.cellAt(editor.selection.start) : undefined);
    if (!c || c.notebook.notebookType !== 'sqlnb') return undefined;
    return { nb: c.notebook, cell: c };
  }

  async explainCell(arg?: vscode.NotebookCell) {
    const t = this.target(arg);
    if (!t || !isSqlLanguage(t.cell.document.languageId) || !t.cell.document.getText().trim()) return;
    const conn = this.kernels.connectionFor(t.nb, t.cell)!;
    const sql = t.cell.document.getText();
    await this.streamInto(t.nb, t.cell, 'explain', async () => ({ system: P.system(conn.driver), user: P.explain(sql, await this.schemaText(t.nb, t.cell, conn, sql)) }));
  }

  async optimizeCell(arg?: vscode.NotebookCell) {
    const t = this.target(arg);
    if (!t || !isSqlLanguage(t.cell.document.languageId) || !t.cell.document.getText().trim()) return;
    const conn = this.kernels.connectionFor(t.nb, t.cell)!;
    const sql = t.cell.document.getText().trim().replace(/;\s*$/, '');
    await this.streamInto(t.nb, t.cell, 'optimize', async () => {
      let plan: string | undefined;
      if (/^\s*(select|with)\b/i.test(sql) && !sql.includes(';')) {
        plan = await this.kernels.session(t.nb, conn).then((s) => s.explain(sql)).catch(() => undefined);
      }
      return { system: P.system(conn.driver), user: P.optimize(sql, await this.schemaText(t.nb, t.cell, conn, sql), plan) };
    });
  }

  async fix(outputId: string) {
    const f = this.find(outputId);
    if (!f) return;
    const result = this.resultOf(f.cell);
    if (!result?.error) return;
    const conn = this.kernels.connectionFor(f.nb, f.cell)!;
    const sql = f.cell.document.getText();
    const err = result.error;
    const detail = `${err.message}${err.code ? ` (code ${err.code})` : ''}${err.statementCount > 1 ? `\nFailing statement ${err.statementIndex + 1} of ${err.statementCount}:\n${err.sql}` : ''}`;
    await this.streamInto(f.nb, f.cell, 'fix', async () => ({ system: P.system(conn.driver), user: P.fix(sql, detail, await this.schemaText(f.nb, f.cell, conn, sql)) }));
  }

  async explainResult(outputId: string, index: number) {
    const f = this.find(outputId);
    if (!f) return;
    const result = this.resultOf(f.cell)?.results[index];
    if (!result?.hasRows) return;
    const cfg = vscode.workspace.getConfiguration('sqlNotebook.ai');
    const ai = await this.config();
    // Rows never leave this computer with a local model, so there is nothing to ask.
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(ai.baseUrl ?? '') && (ai.provider === 'ollama' || ai.provider === 'custom');
    if (!local && !cfg.get<boolean>('allowResultData', false)) {
      const ok = await vscode.window.showWarningMessage(
        'Explain Result sends the first 50 rows of this result to your AI provider.',
        { modal: true },
        'Send once',
        'Always allow',
      );
      if (!ok) return;
      if (ok === 'Always allow') await cfg.update('allowResultData', true, vscode.ConfigurationTarget.Global);
    }
    const conn = this.kernels.connectionFor(f.nb, f.cell)!;
    const csv = toCsv(result.columns.map((c) => c.name), result.rows.slice(0, 50));
    await this.streamInto(f.nb, f.cell, 'result', async () => ({ system: P.system(conn.driver), user: P.explainResult(result.sql, csv, result.rows.length) }));
  }

  async applySql(outputId: string, sql: string) {
    const f = this.find(outputId);
    if (!f) return;
    if (isSchemaChange(sql)) {
      const edit = new vscode.WorkspaceEdit();
      const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sql.trim(), SQL_LANGUAGE);
      if (f.cell.metadata?.connection) data.metadata = { connection: f.cell.metadata.connection };
      edit.set(f.nb.uri, [vscode.NotebookEdit.insertCells(f.cell.index + 1, [data])]);
      await vscode.workspace.applyEdit(edit);
      await this.dismiss(outputId);
      return;
    }
    const doc = f.cell.document;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length), sql.trim());
    await vscode.workspace.applyEdit(edit);
    // The AI card and any error it fixed no longer match the cell.
    await this.kernels.withExecution(f.nb, f.cell, async (exec) => {
      await exec.replaceOutput(
        f.cell.outputs.filter((o) => {
          if (o.metadata?.sqlnbId === outputId) return false;
          const item = o.items.find((i) => i.mime === RESULT_MIME);
          return !(item && (JSON.parse(new TextDecoder().decode(item.data)) as ResultPayload).error);
        }),
      );
    });
  }

  async dismiss(outputId: string) {
    const f = this.find(outputId);
    if (!f) return;
    await this.kernels.withExecution(f.nb, f.cell, async (exec) => {
      await exec.replaceOutput(f.cell.outputs.filter((o) => o.metadata?.sqlnbId !== outputId));
    });
  }

  /** Runs an AI cell: writes SQL for the request and puts it in the cell below. */
  async runAiCell(exec: vscode.NotebookCellExecution, nb: vscode.NotebookDocument, cell: vscode.NotebookCell, conn: ConnectionConfig): Promise<boolean> {
    const request = cell.document.getText().trim();
    if (!request) {
      await exec.clearOutput();
      return true;
    }
    const payload = await this.streamInto(nb, cell, 'generate', async () => ({ system: P.system(conn.driver), user: P.generate(request, await this.schemaText(nb, cell, conn, request)) }), exec);
    if (!payload || payload.status !== 'done' || !payload.sql) return false;

    const next = cell.index + 1 < nb.cellCount ? nb.cellAt(cell.index + 1) : undefined;
    const edit = new vscode.WorkspaceEdit();
    const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, payload.sql, SQL_LANGUAGE);
    data.metadata = { ...(cell.metadata?.connection ? { connection: cell.metadata.connection } : {}), generated: true };
    if (next && next.metadata?.generated && isSqlLanguage(next.document.languageId)) {
      edit.set(nb.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(next.index, next.index + 1), [data])]);
    } else {
      edit.set(nb.uri, [vscode.NotebookEdit.insertCells(cell.index + 1, [data])]);
    }
    await vscode.workspace.applyEdit(edit);
    payload.note = 'SQL is in the cell below.';
    await exec.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json(payload, AI_MIME)], { sqlnbId: payload.id }));
    if (vscode.workspace.getConfiguration('sqlNotebook.ai').get<boolean>('runGeneratedSql', false)) {
      setTimeout(() => void vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: cell.index + 1, end: cell.index + 2 }], document: nb.uri }), 50);
    }
    return true;
  }

  /** The tables where the cell's names resolve: after USE, that database's. */
  private schemaText(nb: vscode.NotebookDocument, cell: vscode.NotebookCell, conn: ConnectionConfig, focus: string) {
    return this.schema.describeForAi(conn, focus, this.kernels.whereFor(nb, cell, conn)).catch((e) => `(schema unavailable: ${e instanceof Error ? e.message : String(e)})`);
  }
}

export function toCsv(header: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? ('$bin' in (v as object) ? `0x${(v as any).$bin}` : JSON.stringify(v)) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}
