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

export const PLAN_MIME = 'application/vnd.sqlnotebook.plan+json';

/** Drivers whose plans Query Flow can read. The renderer uses this to show its button. */
export const PLAN_DRIVERS: ReadonlySet<string> = new Set(['postgres', 'mysql', 'mssql', 'sqlite', 'duckdb']);

export type StepKind = 'scan' | 'join' | 'filter' | 'group' | 'sort' | 'topn' | 'limit' | 'distinct' | 'window' | 'combine' | 'values' | 'select' | 'write' | 'other';

/** One Query Flow step: one step of the run order, from the database's query plan. */
export interface PlanStep {
  /** 1-based, in the order the steps run. */
  n: number;
  kind: StepKind;
  title: string;
  /** A plain-English sentence. */
  detail?: string;
  /** The planner's estimate of the rows this step passes on. */
  rows?: number;
  /** Steps whose rows this step reads. */
  inputs: number[];
  /** 0-based lines of `PlanPayload.sql` this step comes from. */
  lines: number[];
  /** Not listed by the database's plan, but it happens (e.g. SQLite's LIMIT). */
  inferred?: boolean;
}

export interface PlanPayload {
  v: 1;
  id?: string;
  connection: string;
  driver: string;
  /** The statement shown, as written in the cell. */
  sql: string;
  /** 0-based line of the statement in the cell, for line numbers. */
  firstLine: number;
  steps: PlanStep[];
  /** Clause keywords in the order they are written (SELECT, FROM, ...). */
  written: string[];
  /** The result output of the cell when this was opened: its Query Flow button shows it is open. */
  resultId?: string;
  note?: string;
  error?: string;
}

export const STEPS_MIME = 'application/vnd.sqlnotebook.steps+json';

/** The clauses Query Steps can stop after, in the order a database applies them. */
export type QueryStepKind = 'from' | 'join' | 'where' | 'group' | 'having' | 'select' | 'distinct' | 'order' | 'limit';

/** Some of the rows a step produced (or dropped). */
export interface StepRows {
  columns: Column[];
  rows: Cell[][];
  /** More rows exist than are shown. */
  more: boolean;
}

/** One Query Steps step: the rows after one clause, from running the query up to that clause. */
export interface QueryStep {
  /** 1-based. */
  n: number;
  kind: QueryStepKind;
  /** The keyword as written: FROM, LEFT JOIN, WHERE, GROUP BY, ... */
  clause: string;
  /** The clause, shortened: "WHERE o.status = 'paid'". */
  title: string;
  /** A plain-English sentence about what this step did. */
  detail?: string;
  /** Rows (or groups) after this step, when known. */
  rows?: number;
  unit: 'rows' | 'groups';
  /** Rows this step dropped, when known. */
  removed?: number;
  /** What `removedRows` holds: rows this step dropped, or (LEFT JOIN) rows kept with no match. */
  removedLabel?: string;
  sample?: StepRows;
  removedRows?: StepRows;
  /** The query run to show this step's rows. */
  sql?: string;
  /** 0-based lines of `StepsPayload.sql` this step comes from. */
  lines: number[];
  status: 'pending' | 'running' | 'done' | 'error';
  error?: string;
}

export interface StepsPayload {
  v: 1;
  id?: string;
  connection: string;
  driver: string;
  /** The statement shown, as written in the cell. */
  sql: string;
  /** 0-based line of the statement in the cell, for line numbers. */
  firstLine: number;
  steps: QueryStep[];
  /** Rows shown per step. */
  sampleRows: number;
  /** True while steps are still running. */
  running?: boolean;
  /** The result output of the cell when this was opened: its Query Steps button shows it is open. */
  resultId?: string;
  note?: string;
  error?: string;
}

// Messages the renderer sends to the extension.
export type RendererMessage =
  | { type: 'copy'; text: string }
  | { type: 'export'; format: 'csv' | 'json'; name: string; columns: Column[]; rows: Cell[][] }
  | { type: 'savePng'; dataUrl: string }
  | { type: 'setChart'; outputId: string; chart?: ChartConfig; view: 'table' | 'chart' }
  | { type: 'fix'; outputId: string }
  | { type: 'explainResult'; outputId: string; resultIndex: number }
  | { type: 'queryFlow'; outputId: string; resultIndex: number }
  | { type: 'querySteps'; outputId: string; resultIndex: number }
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

/** A SELECT (or WITH ... SELECT): the statements Query Steps can step through. */
export function isSelect(sql: string): boolean {
  return /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(select|with)\b/i.test(sql);
}

/** The same statement, ignoring surrounding space and a final semicolon. */
export function sameStatement(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r\n?/g, '\n').trim().replace(/;\s*$/, '').trim();
  return norm(a) === norm(b);
}

/** AI suggestions that change the schema (like CREATE INDEX) go in a new cell instead of replacing the query. */
export function isSchemaChange(sql: string): boolean {
  return /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(create|alter|drop|analyze|vacuum|reindex)\b/i.test(sql);
}
