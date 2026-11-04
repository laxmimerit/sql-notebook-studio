// The Connections view: folders → connections → databases/schemas → tables → columns.

import * as vscode from 'vscode';
import type { ColumnInfo, ConnectionConfig, TableInfo } from '../db/types';
import { DRIVERS } from '../db/types';
import { describe, type ConnectionStore } from '../connections/store';
import type { SessionManager } from '../db/manager';
import type { SchemaCache } from './cache';

export type Node =
  | { kind: 'folder'; name: string }
  | { kind: 'connection'; conn: ConnectionConfig }
  | { kind: 'container'; conn: ConnectionConfig; name: string }
  | { kind: 'table'; conn: ConnectionConfig; container?: string; table: TableInfo }
  | { kind: 'column'; conn: ConnectionConfig; container?: string; table: string; column: ColumnInfo }
  | { kind: 'message'; text: string; tooltip?: string; icon: string; command?: vscode.Command };

const ENV_COLOR: Record<string, string> = { production: 'charts.red', staging: 'charts.orange', dev: 'charts.green' };

/** Scheme of the connection rows' resourceUri, so the status dot can be drawn as a decoration. */
const STATUS_SCHEME = 'sqlnb-connection';

export class ConnectionsTree implements vscode.TreeDataProvider<Node>, vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decoEmitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decoEmitter.event;
  /** Connections whose last schema lookup failed, with the error. */
  private readonly failed = new Map<string, string>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: SessionManager,
    private readonly cache: SchemaCache,
    private readonly mediaDir: vscode.Uri,
  ) {
    store.onDidChange(() => this.refresh());
    manager.onDidChange((id) => {
      // Disconnected: forget the old error; the next expand tries again.
      if (!manager.isConnected(id)) this.failed.delete(id);
      this.refresh();
    });
  }

  refresh(connId?: string) {
    if (connId) this.cache.invalidate(connId);
    this.emitter.fire(undefined);
    this.decoEmitter.fire(undefined);
  }

  /**
   * A notebook just ran on this connection without error. If the explorer is
   * showing it as failed, look again: the connection works.
   */
  recheck(connId: string) {
    if (this.failed.has(connId)) this.refresh(connId);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== STATUS_SCHEME) return undefined;
    const id = decodeURIComponent(uri.path.slice(1));
    if (this.failed.has(id)) return { badge: '!', color: new vscode.ThemeColor('list.warningForeground'), tooltip: "Can't connect" };
    if (this.manager.isConnected(id)) return { badge: '●', color: new vscode.ThemeColor('charts.green'), tooltip: 'Connected' };
    return undefined;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'folder': {
        const t = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Expanded);
        t.iconPath = new vscode.ThemeIcon('folder');
        t.contextValue = 'folder';
        return t;
      }
      case 'connection': {
        const c = n.conn;
        const online = this.manager.isConnected(c.id);
        const t = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.Collapsed);
        t.id = `conn:${c.id}`;
        t.resourceUri = vscode.Uri.from({ scheme: STATUS_SCHEME, path: '/' + encodeURIComponent(c.id) });
        t.description = describe(c);
        const color = c.env && ENV_COLOR[c.env] ? new vscode.ThemeColor(ENV_COLOR[c.env]) : undefined;
        t.iconPath = color ? new vscode.ThemeIcon(online ? 'database' : 'database', color) : vscode.Uri.joinPath(this.mediaDir, 'drivers', `${DRIVERS[c.driver].icon}.svg`);
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`**${escapeMd(c.name)}**  \n${DRIVERS[c.driver].label} · ${escapeMd(describe(c))}`);
        if (c.env && c.env !== 'none') md.appendMarkdown(`  \nTag: ${c.env}`);
        if (c.readOnly) md.appendMarkdown('  \nRead-only');
        if (c.ssh?.enabled) md.appendMarkdown(`  \nSSH via ${escapeMd(c.ssh.host)}`);
        const err = this.failed.get(c.id);
        md.appendMarkdown(`  \n${err ? `$(warning) Can't connect: ${escapeMd(err.split('\n')[0].slice(0, 200))}` : online ? '$(pass-filled) Connected' : '$(circle-outline) Not connected'}`);
        t.tooltip = md;
        t.contextValue = `connection.${online ? 'online' : 'offline'}.${c.builtin ? 'builtin' : 'user'}`;
        return t;
      }
      case 'container': {
        const t = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Collapsed);
        t.id = `ct:${n.conn.id}:${n.name}`;
        t.iconPath = new vscode.ThemeIcon(n.conn.driver === 'mysql' ? 'database' : 'symbol-namespace');
        t.contextValue = 'database';
        return t;
      }
      case 'table': {
        const t = new vscode.TreeItem(n.table.name, vscode.TreeItemCollapsibleState.Collapsed);
        t.id = `tb:${n.conn.id}:${n.container ?? ''}:${n.table.name}`;
        t.iconPath = new vscode.ThemeIcon(n.table.type === 'view' ? 'eye' : 'table');
        if (n.table.type === 'view') t.description = 'view';
        t.contextValue = 'table';
        return t;
      }
      case 'column': {
        const t = new vscode.TreeItem(n.column.name, vscode.TreeItemCollapsibleState.None);
        t.description = n.column.type.toLowerCase() + (n.column.nullable === false && !n.column.pk ? ' · not null' : '');
        t.iconPath = new vscode.ThemeIcon(n.column.pk ? 'key' : 'symbol-field');
        t.contextValue = 'column';
        return t;
      }
      case 'message': {
        const t = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
        t.iconPath = new vscode.ThemeIcon(n.icon);
        t.tooltip = n.tooltip;
        t.command = n.command;
        return t;
      }
    }
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) {
      const all = this.store.list();
      const user = all.filter((c) => !c.builtin);
      const folders = [...new Set(user.map((c) => c.folder?.trim()).filter(Boolean) as string[])].sort();
      return [
        ...folders.map((name) => ({ kind: 'folder', name }) as Node),
        ...user.filter((c) => !c.folder?.trim()).map((conn) => ({ kind: 'connection', conn }) as Node),
        { kind: 'folder', name: 'Built-in' },
      ];
    }
    try {
      switch (n.kind) {
        case 'folder':
          return this.store
            .list()
            .filter((c) => (n.name === 'Built-in' ? c.builtin : !c.builtin && c.folder?.trim() === n.name))
            .map((conn) => ({ kind: 'connection', conn }));
        case 'connection': {
          const containers = await this.cache.containers(n.conn);
          const kids: Node[] = containers && containers.length > 1
            ? containers.map((name) => ({ kind: 'container', conn: n.conn, name }))
            : await this.tables(n.conn, containers?.[0]);
          this.markOk(n.conn.id);
          return kids;
        }
        case 'container':
          return this.tables(n.conn, n.name);
        case 'table': {
          const cols = await this.cache.columns(n.conn, n.table.name, n.container);
          return cols.map((column) => ({ kind: 'column', conn: n.conn, container: n.container, table: n.table.name, column }));
        }
        default:
          return [];
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const conn = 'conn' in n ? n.conn : undefined;
      if (conn && !this.failed.has(conn.id)) {
        this.failed.set(conn.id, msg);
        this.decoEmitter.fire(undefined);
      }
      return [
        {
          kind: 'message',
          text: `Can't connect: ${msg.split('\n')[0].slice(0, 80)}`,
          tooltip: msg,
          icon: 'warning',
          command: conn && !conn.builtin ? { command: 'sqlNotebook.editConnection', title: 'Edit', arguments: [{ kind: 'connection', conn }] } : undefined,
        },
      ];
    }
  }

  private markOk(connId: string) {
    if (this.failed.delete(connId)) this.decoEmitter.fire(undefined);
  }

  private async tables(conn: ConnectionConfig, container?: string): Promise<Node[]> {
    const tables = await this.cache.tables(conn, container);
    if (!tables.length) return [{ kind: 'message', text: 'No tables yet', icon: 'info' }];
    const sorted = [...tables].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'table' ? -1 : 1));
    return sorted.map((table) => ({ kind: 'table', conn, container, table }));
  }
}

function escapeMd(s: string) {
  return s.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

/** Quotes an identifier for the driver. */
export function quoteIdent(driver: ConnectionConfig['driver'], name: string): string {
  if (driver === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
  if (driver === 'mssql') return '[' + name.replace(/]/g, ']]') + ']';
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : '"' + name.replace(/"/g, '""') + '"';
}

export function qualified(driver: ConnectionConfig['driver'], table: string, container?: string): string {
  const t = quoteIdent(driver, table);
  if (!container || ((driver === 'postgres' || driver === 'duckdb') && container === 'public') || (driver === 'duckdb' && container === 'main')) return t;
  return `${quoteIdent(driver, container)}.${t}`;
}

export function selectTopSql(driver: ConnectionConfig['driver'], table: string, container?: string): string {
  const q = qualified(driver, table, container);
  return driver === 'mssql' ? `SELECT TOP 100 *\nFROM ${q};` : `SELECT *\nFROM ${q}\nLIMIT 100;`;
}

export function describeSql(driver: ConnectionConfig['driver'], table: string, container?: string): string {
  const q = qualified(driver, table, container);
  switch (driver) {
    case 'mysql':
    case 'duckdb':
      return `DESCRIBE ${q};`;
    case 'sqlite':
      return `PRAGMA table_info(${quoteIdent(driver, table)});`;
    case 'postgres':
      return `SELECT column_name, data_type, is_nullable, column_default\nFROM information_schema.columns\nWHERE table_schema = '${(container ?? 'public').replace(/'/g, "''")}' AND table_name = '${table.replace(/'/g, "''")}'\nORDER BY ordinal_position;`;
    case 'mssql':
      return `EXEC sp_columns @table_name = N'${table.replace(/'/g, "''")}'${container ? `, @table_owner = N'${container.replace(/'/g, "''")}'` : ''};`;
  }
}
