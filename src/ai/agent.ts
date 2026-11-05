// Agent mode: a LangChain agent that plans with write_todos (todo list
// middleware), looks at the database through read-only tools, checks its SQL,
// and only then answers. Every tool call is reported so the AI card can show
// how the answer was made. The tools themselves live in the extension
// (service.ts) and are passed in as plain functions.

import { createAgent, modelCallLimitMiddleware, todoListMiddleware, tool } from 'langchain';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import type { AiStep, AiTodo } from '../../shared/protocol';
import { createModel, type AiConfig } from './models';

export interface TableArgs {
  table: string;
  database?: string;
  schema?: string;
}

/** What the agent can do. Every handler returns text for the model. */
export interface AgentHandlers {
  listDatabases?: () => Promise<string>;
  listTables: (a: { database?: string; schema?: string }) => Promise<string>;
  describeTable: (a: TableArgs) => Promise<string>;
  /** Only given when result data may go to the model. */
  sampleRows?: (a: TableArgs) => Promise<string>;
  /** `standalone`: check the SQL on its own, ignoring tables created by SQL checked before. */
  checkSql: (a: { sql: string; standalone?: boolean }) => Promise<string>;
}

export interface AgentProgress {
  /** The answer so far (the final answer once done). */
  text: string;
  steps: AiStep[];
  todos: AiTodo[];
}

export interface AgentOptions {
  system: string;
  user: string;
  handlers: AgentHandlers;
  signal?: AbortSignal;
  /** Most model calls in one run. */
  maxModelCalls?: number;
  onUpdate: (p: AgentProgress) => void;
}

const NO_TOOLS = /does(n't| not) support tools|not support (tool|function)|tools? (calling |use )?(is |are )?not supported|no endpoints found that support tool|function calling is not (enabled|supported)|tool_choice|tool use is not/i;

/** Thrown when the model cannot call tools, so the caller can answer directly. */
export class NoToolSupport extends Error {
  readonly noToolSupport = true;
}

const OUT_MAX = 2000;

export async function runAgent(cfg: AiConfig, o: AgentOptions): Promise<AgentProgress> {
  const h = o.handlers;
  const tools = [
    tool(async (a: { database?: string; schema?: string }) => h.listTables(a), {
      name: 'list_tables',
      description: 'Lists the tables and views. With no arguments: where the notebook is now.',
      schema: z.object({
        database: z.string().optional().describe('Another database on the same server'),
        schema: z.string().optional().describe('A schema other than the default one'),
      }),
    }),
    tool(async (a: TableArgs) => h.describeTable(a), {
      name: 'describe_table',
      description: 'Shows the columns of one table or view: name, type, primary key, nullable.',
      schema: z.object({
        table: z.string().describe('Table name, may be written schema.table or database.schema.table'),
        database: z.string().optional(),
        schema: z.string().optional(),
      }),
    }),
    tool(async (a: { sql: string }) => h.checkSql(a), {
      name: 'check_sql',
      description: 'Checks SQL against the real database without running it: syntax, tables and columns. Nothing is executed and no data changes. Returns OK or the error.',
      schema: z.object({ sql: z.string().describe('The full SQL you plan to answer with') }),
    }),
  ];
  if (h.listDatabases) {
    tools.unshift(
      tool(async () => h.listDatabases!(), {
        name: 'list_databases',
        description: 'Lists the databases on this server and says which one the notebook is in.',
        schema: z.object({}),
      }) as any,
    );
  }
  if (h.sampleRows) {
    tools.push(
      tool(async (a: TableArgs) => h.sampleRows!(a), {
        name: 'sample_rows',
        description: 'Returns 5 rows of a table, to see what the values look like (formats, codes, NULLs).',
        schema: z.object({ table: z.string(), database: z.string().optional(), schema: z.string().optional() }),
      }) as any,
    );
  }

  const model = createModel(cfg);
  const agent = createAgent({
    model,
    tools,
    systemPrompt: o.system,
    middleware: [todoListMiddleware(), modelCallLimitMiddleware({ runLimit: o.maxModelCalls ?? 10, exitBehavior: 'end' })],
    // Keeps the conversation, so a failed check can be sent back as a follow-up.
    checkpointer: new MemorySaver(),
  });
  const thread = { configurable: { thread_id: 'sqlnb' } };

  const state: AgentProgress = { text: '', steps: [], todos: [] };
  let live = '';
  let final: string | undefined;
  let plans = 0;
  const emit = () => o.onUpdate({ text: final ?? live, steps: state.steps, todos: state.todos });

  const seen = new Set<string>();
  /** One run of the agent; returns once it has answered or hit the step limit. */
  const pass = async (message: string) => {
    final = undefined;
    live = '';
    const stream = await agent.stream({ messages: [new HumanMessage(message)] } as any, {
      ...thread,
      streamMode: ['updates', 'messages'],
      signal: o.signal,
      recursionLimit: 80,
    } as any);
    for await (const item of stream as AsyncIterable<[string, any]>) {
      const [mode, data] = item;
      if (mode === 'messages') {
        const [chunk] = data as [any, unknown];
        const type = typeOf(chunk);
        if (type !== 'ai' && type !== 'AIMessageChunk') continue;
        const t = textOf(chunk.content);
        if (t) {
          live += t;
          emit();
        }
        continue;
      }
      for (const update of Object.values(data ?? {}) as any[]) {
        if (!update || typeof update !== 'object') continue;
        if (Array.isArray(update.todos)) state.todos = update.todos.map((t: any) => ({ content: String(t.content ?? ''), status: t.status ?? 'pending' }));
        for (const m of (update.messages ?? []) as any[]) {
          // Some nodes send the whole message list again: take each message once.
          const key = m.id ?? m.tool_call_id ?? (m.tool_calls ?? []).map((c: any) => c.id).join(',') ?? '';
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          const type = typeOf(m);
          if (type === 'ai') {
            const text = textOf(m.content).trim();
            const calls = (m.tool_calls ?? []) as { id?: string; name: string; args: any }[];
            if (calls.length) {
              if (text) state.steps.push({ id: `t${state.steps.length}`, kind: 'thought', title: firstLine(text), output: clip(text), status: 'done' });
              for (const c of calls) {
                if (c.id && state.steps.some((x) => x.id === c.id)) continue;
                const plan = c.name === 'write_todos';
                state.steps.push({
                  id: c.id ?? `s${state.steps.length}`,
                  kind: plan ? 'plan' : 'tool',
                  title: plan ? (plans++ ? 'Updated the plan' : 'Made a plan') : titleFor(c.name, c.args ?? {}),
                  input: plan ? undefined : inputFor(c.name, c.args ?? {}),
                  status: 'running',
                });
              }
              live = '';
            } else if (/^model call limits? exceeded/i.test(text)) {
              // modelCallLimitMiddleware ends the run with this note: not an answer.
              final = undefined;
            } else {
              final = text;
            }
          } else if (type === 'tool') {
            const step = state.steps.find((x) => x.id === m.tool_call_id);
            if (!step) continue;
            const out = typeof m.content === 'string' ? m.content : textOf(m.content);
            step.status = m.status === 'error' || FAILED.test(out) ? 'error' : 'done';
            if (step.kind !== 'plan') step.output = clip(out);
          }
        }
        emit();
      }
    }
    for (const x of state.steps) if (x.status === 'running') x.status = 'done';
  };

  try {
    await pass(o.user);
  } catch (e) {
    if (!o.signal?.aborted && !state.steps.length && NO_TOOLS.test(e instanceof Error ? e.message : String(e))) {
      throw new NoToolSupport(e instanceof Error ? e.message : String(e));
    }
    throw e;
  }

  // Never hand over SQL that was not checked. The final SQL is checked here
  // on its own, whatever the model checked before (it may have checked a
  // CREATE TABLE and the query in separate calls, then left the CREATE out of
  // its answer). A failure goes back to the model, at most twice.
  for (let round = 0; round < 2 && final?.trim(); round++) {
    const sql = lastSql(final);
    if (!sql) break;
    const step: AiStep = { id: `f${state.steps.length}`, kind: 'tool', title: 'Checked the final SQL', input: sql, status: 'running' };
    state.steps.push(step);
    emit();
    const result = await h.checkSql({ sql, standalone: true }).catch((e) => `Error: ${e instanceof Error ? e.message : String(e)}`);
    step.output = clip(result);
    step.status = FAILED.test(result) ? 'error' : 'done';
    emit();
    if (!FAILED.test(result) || /could not connect/i.test(result)) break;
    await pass(
      `check_sql found a problem with the SQL in your answer, checked on its own:\n${result}\n\nFix it and answer again in the same shape. The SQL block must hold every statement the request needs, in order (for example the CREATE TABLE before the query that uses it).`,
    );
  }

  for (const s of state.steps) if (s.status === 'running') s.status = 'done';

  // The step limit ended the run before an answer: answer once more, no tools,
  // from what the tools found.
  if (!final?.trim()) {
    state.steps.push({ id: 'limit', kind: 'thought', title: 'Step limit reached: answering with what it found', status: 'done' });
    const found = state.steps
      .filter((s) => s.kind === 'tool')
      .map((s) => `### ${s.title}\n${s.input ? `Input:\n${s.input}\n` : ''}Result:\n${s.output ?? ''}`)
      .join('\n\n');
    live = '';
    final = undefined;
    const answer = await model.stream(
      [new SystemMessage(o.system), new HumanMessage(`${o.user}\n\nWhat you found with the tools:\n\n${found || '(nothing)'}\n\nYou cannot use tools any more. Give your final answer now, in the shape asked.`)],
      { signal: o.signal },
    );
    for await (const chunk of answer) {
      live += textOf(chunk.content);
      emit();
    }
    final = live.trim();
  }

  state.text = final;
  emit();
  return state;
}

/** The last ```sql block of an answer. */
function lastSql(md: string): string | undefined {
  const blocks = [...md.matchAll(/```(?:sql|mysql|postgresql|tsql|sqlite)?\s*\n([\s\S]*?)```/gi)];
  return blocks.at(-1)?.[1]?.trim() || undefined;
}

const FAILED = /^(error|failed)\b/i;

const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().replace(/;$/, '') === b.replace(/\s+/g, ' ').trim().replace(/;$/, '');

function typeOf(m: any): string {
  return (typeof m?.getType === 'function' ? m.getType() : m?._getType?.()) ?? m?.type ?? '';
}

function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('');
  return '';
}

const clip = (s: string) => (s.length > OUT_MAX ? s.slice(0, OUT_MAX) + '\n…' : s);

function firstLine(s: string) {
  const line = s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim().split('\n')[0].replace(/[*_`#]/g, '').trim();
  return line.length > 90 ? line.slice(0, 87) + '…' : line || 'Thinking';
}

function nameOf(a: { table?: string; database?: string; schema?: string }) {
  // The model may write the table as schema.table and pass the schema too.
  const dots = (a.table?.match(/\./g) ?? []).length;
  return [dots ? (dots < 2 ? a.database : undefined) : a.database, dots ? undefined : a.schema, a.table].filter(Boolean).join('.');
}

function titleFor(name: string, a: any): string {
  switch (name) {
    case 'list_databases':
      return 'Listed the databases';
    case 'list_tables':
      return `Listed the tables${a.database || a.schema ? ` in ${[a.database, a.schema].filter(Boolean).join('.')}` : ''}`;
    case 'describe_table':
      return `Read the columns of ${nameOf(a)}`;
    case 'sample_rows':
      return `Looked at 5 rows of ${nameOf(a)}`;
    case 'check_sql':
      return 'Checked the SQL against the database';
    default:
      return `Used ${name}`;
  }
}

function inputFor(name: string, a: any): string | undefined {
  if (name === 'check_sql') return typeof a.sql === 'string' ? a.sql : undefined;
  return undefined;
}
