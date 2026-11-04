// The connection form, shown in an editor tab. The UI is a React webview.

import * as vscode from 'vscode';
import type { ConnectionConfig, Secrets } from '../db/types';
import { newId, type ConnectionStore } from './store';
import type { SessionManager } from '../db/manager';
import { parseConnectionString } from './connString';

const panels = new Map<string, vscode.WebviewPanel>();

export interface FormDeps {
  ctx: vscode.ExtensionContext;
  store: ConnectionStore;
  manager: SessionManager;
  onSaved: (conn: ConnectionConfig) => void;
}

export function openConnectionForm(deps: FormDeps, existing?: ConnectionConfig) {
  const key = existing?.id ?? 'new';
  const open = panels.get(key);
  if (open) {
    open.reveal();
    return;
  }
  const { ctx, store, manager } = deps;
  const panel = vscode.window.createWebviewPanel(
    'sqlNotebook.connection',
    existing ? `Edit ${existing.name}` : 'New Connection',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')] },
  );
  panels.set(key, panel);
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'activity.svg');
  panel.onDidDispose(() => panels.delete(key));
  panel.webview.html = html(panel.webview, ctx.extensionUri);

  const post = (msg: unknown) => void panel.webview.postMessage(msg);
  const folders = [...new Set(store.list().filter((c) => !c.builtin && c.folder).map((c) => c.folder!))];

  const mergeSecrets = async (id: string | undefined, s: Partial<Secrets>): Promise<Secrets> => {
    const saved = id ? await store.secrets(id) : {};
    const out: Secrets = { ...saved };
    for (const k of Object.keys(s) as (keyof Secrets)[]) if (s[k] !== undefined) out[k] = s[k];
    return out;
  };

  panel.webview.onDidReceiveMessage(async (msg) => {
    try {
      switch (msg.type) {
        case 'ready': {
          const saved = existing ? await store.secrets(existing.id) : {};
          post({
            type: 'init',
            conn: existing ?? null,
            has: { password: !!saved.password, sshPassword: !!saved.sshPassword, sshPassphrase: !!saved.sshPassphrase },
            folders,
            suggestedName: store.uniqueName('New connection'),
          });
          break;
        }
        case 'test': {
          const conn = msg.conn as ConnectionConfig;
          const t0 = Date.now();
          let session;
          try {
            session = await manager.open({ ...conn, id: conn.id || 'test' }, await mergeSecrets(existing?.id, msg.secrets));
            const version = await session.serverVersion();
            post({ type: 'testResult', ok: true, message: `Connected · ${version} · ${Date.now() - t0} ms` });
          } catch (e) {
            post({ type: 'testResult', ok: false, message: e instanceof Error ? e.message : String(e) });
          } finally {
            await session?.close().catch(() => undefined);
          }
          break;
        }
        case 'save': {
          const conn = { ...(msg.conn as ConnectionConfig), id: existing?.id ?? newId() };
          if (!conn.name?.trim()) throw new Error('Give the connection a name.');
          conn.name = conn.name.trim();
          if (store.nameTaken(conn.name, conn.id)) throw new Error(`"${conn.name}" is already used. Pick another name.`);
          await store.save(conn, msg.secrets ?? {});
          if (existing) await manager.dropConnection(conn.id);
          deps.onSaved(conn);
          panel.dispose();
          break;
        }
        case 'browse': {
          const uris = msg.save
            ? [await vscode.window.showSaveDialog({ filters: msg.filters, title: msg.title })].filter(Boolean)
            : await vscode.window.showOpenDialog({ canSelectMany: false, filters: msg.filters, title: msg.title });
          const uri = uris?.[0];
          if (uri) post({ type: 'browsed', field: msg.field, path: uri.fsPath });
          break;
        }
        case 'parse': {
          const parsed = parseConnectionString(msg.text);
          post({ type: 'parsed', config: parsed.config, password: parsed.password });
          break;
        }
        case 'clipboard': {
          // Pre-fill the paste box when the clipboard already holds a connection string.
          const text = (await vscode.env.clipboard.readText()).trim();
          if (text.length < 2000 && /^[a-z][a-z0-9+.-]*:\/\/|(^|;)\s*(server|data source|host)\s*=/i.test(text)) post({ type: 'clipboard', text });
          break;
        }
        case 'cancel':
          panel.dispose();
          break;
      }
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Opens the form prefilled as a copy of a connection. */
export async function duplicateConnection(deps: FormDeps, conn: ConnectionConfig) {
  const copy: ConnectionConfig = { ...conn, id: newId(), name: deps.store.uniqueName(`${conn.name} copy`), builtin: undefined };
  await deps.store.save(copy, {});
  await deps.store.copySecrets(conn.id, copy.id);
  openConnectionForm(deps, copy);
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'dist', 'webview.js'));
  const codicons = webview.asWebviewUri(vscode.Uri.joinPath(root, 'dist', 'media', 'codicon.css'));
  const drivers = webview.asWebviewUri(vscode.Uri.joinPath(root, 'media', 'drivers'));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${codicons}">
<title>Connection</title></head>
<body><div id="root" data-drivers="${drivers}"></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}
