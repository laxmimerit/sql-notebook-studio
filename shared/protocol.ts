// Types shared by the extension host and the notebook renderer.

export const RESULT_MIME = 'application/vnd.sqlnotebook.result+json';
export const AI_MIME = 'application/vnd.sqlnotebook.ai+json';

export type ColumnKind = 'number' | 'string' | 'bool' | 'date' | 'json' | 'binary' | 'other';

export interface Column {
  name: string;
  type: string;
  kind: ColumnKind;
}

/** Binary values travel as a short hex preview plus the full length. */
export interface BinaryValue {
  $bin: string;
  len: number;
}

export type Cell = string | number | boolean | null | BinaryValue | unknown[] | Record<string, unknown>;

export interface StatementResult {
  sql: string;
  columns: Column[];
  rows: Cell[][];
  /** True when the statement returned rows (a SELECT). False for commands. */
  hasRows: boolean;
  truncated: boolean;
  affected?: number;
  durationMs: number;
  messages?: string[];
}

export type ChartType = 'bar' | 'line' | 'area' | 'scatter' | 'pie';

export interface ChartConfig {
  type: ChartType;
  x: string;
  y: string[];
  stacked?: boolean;
  horizontal?: boolean;
}

export interface QueryError {
  message: string;
  code?: string;
  statementIndex: number;
  statementCount: number;
  sql: string;
  line?: number;
}

export interface ResultPayload {
  v: 1;
  /** Stable id of the output, also stored in the output's metadata as sqlnbId. */
  id?: string;
  connection: string;
  driver: string;
  results: StatementResult[];
  running?: { index: number; count: number };
  error?: QueryError;
  chart?: ChartConfig;
  view?: 'table' | 'chart';
  aiEnabled: boolean;
  maxRows: number;
}

export type AiKind = 'explain' | 'optimize' | 'fix' | 'result' | 'generate';

export interface AiPayload {
  v: 1;
  id?: string;
  kind: AiKind;
  status: 'streaming' | 'done' | 'error';
  markdown: string;
  sql?: string;
  model: string;
  note?: string;
  /** Agent mode: the plan the model wrote with write_todos, latest version. */
  todos?: AiTodo[];
  /** Agent mode: what the model did, in order (tool calls and their results). */
  steps?: AiStep[];
  /** A short line under the answer, e.g. why agent mode fell back to a direct answer. */
  notice?: string;
}

export interface AiTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface AiStep {
  id: string;
  kind: 'plan' | 'tool' | 'thought';
  title: string;
  /** Tool input, e.g. the SQL given to check_sql. */
  input?: string;
  /** Tool result or the model's note, shortened. */
  output?: string;
  status: 'running' | 'done' | 'error';
}

// Messages the renderer sends to the extension.
export type RendererMessage =
  | { type: 'copy'; text: string }
  | { type: 'export'; format: 'csv' | 'json'; name: string; columns: Column[]; rows: Cell[][] }
  | { type: 'savePng'; dataUrl: string }
  | { type: 'setChart'; outputId: string; chart?: ChartConfig; view: 'table' | 'chart' }
  | { type: 'fix'; outputId: string }
  | { type: 'explainResult'; outputId: string; resultIndex: number }
  | { type: 'applySql'; outputId: string; sql: string }
  | { type: 'runCell'; outputId: string }
  | { type: 'dismissAi'; outputId: string }
  | { type: 'configureAi' }
  | { type: 'openSetting'; key: string };

// Messages the extension sends to the renderer.
export type HostMessage =
  /** Does nothing; tells the extension whether the renderer is loaded. */
  | { type: 'ping' }
  /**
   * Shift+Enter ran the cell showing `outputId`: once its result is drawn, put
   * that cell `ratio` of the window from the top. With `fit`, instead scroll
   * only when the next cell would end up in the bottom `ratio` of the window,
   * and then just enough to bring it above that line. `nextOutputId` is the
   * next cell's own result, if it has one, which gives that cell's exact position.
   */
  | { type: 'placeAfterRun'; outputId: string; nextOutputId?: string; ratio: number; fit?: boolean }
  /** The cell that was run was just put at the top of the window: move it down to `ratio`. */
  | { type: 'lowerTop'; ratio: number };

/** AI suggestions that change the schema (like CREATE INDEX) go in a new cell instead of replacing the query. */
export function isSchemaChange(sql: string): boolean {
  return /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(create|alter|drop|analyze|vacuum|reindex)\b/i.test(sql);
}
