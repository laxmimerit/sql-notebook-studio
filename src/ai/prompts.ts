// Prompts for every AI action. Answers are short Markdown with fixed sections.

import type { DriverId } from '../db/types';

const DIALECT: Record<DriverId, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  mssql: 'SQL Server (T-SQL)',
  sqlite: 'SQLite',
  duckdb: 'DuckDB',
};

export function system(driver: DriverId): string {
  return [
    `You are a senior ${DIALECT[driver]} engineer helping a developer inside a SQL notebook.`,
    'Write plain, direct Markdown. No greeting, no preamble, no closing summary.',
    'Use only tables and columns that exist in the schema you are given. Never invent them.',
    `Any SQL you write must be valid ${DIALECT[driver]}, inside one \`\`\`sql code block.`,
  ].join('\n');
}

/** System prompt for agent mode: same rules, plus how to use the tools. */
export function agentSystem(driver: DriverId, o: { sample: boolean; databases: boolean }): string {
  return [
    system(driver),
    '',
    'You can look at the database through read-only tools. They never change data, and you cannot run the query: the user runs it.',
    'How to work:',
    '- If the task has several parts, first write a short plan with write_todos (2 to 5 items) and keep it updated. For a simple request, skip the plan.',
    `- The schema in the request may be incomplete. Confirm every table and column you use with ${o.databases ? 'list_databases, ' : ''}list_tables or describe_table. Never guess a name.`,
    o.sample ? '- Use sample_rows only when the values matter (formats, codes, NULLs).' : '',
    '- Before you answer with SQL, pass the exact SQL to check_sql and fix every error it reports. Check it again after a fix.',
    '- Be efficient: a few tool calls are usually enough. Do not look at tables the request does not need.',
    '- Your final message is all the user sees of your answer: write it in the shape the request asks for, with the SQL in one ```sql code block.',
  ]
    .filter(Boolean)
    .join('\n');
}

const block = (sql: string) => '```sql\n' + sql.trim() + '\n```';

export function explain(sql: string, schema: string): string {
  return `Explain this query.

Answer in exactly this shape:
**In short:** one sentence on what the query returns.

**Step by step**
- 3 to 7 bullets in the order the database runs it (FROM/JOIN, WHERE, GROUP BY, HAVING, SELECT, ORDER BY, LIMIT). Name the real tables and columns.

**Watch out**
- 0 to 3 bullets on real pitfalls or performance issues. Leave this section out if there are none.

Schema:
${schema}

Query:
${block(sql)}`;
}

export function optimize(sql: string, schema: string, plan?: string): string {
  return `Review this query for performance.

Answer in exactly this shape:
**Verdict:** one sentence.

**What the plan shows**
- 2 to 4 bullets.${plan ? '' : ' (No plan was available; reason from the query and schema.)'}

**Improvements**
- Concrete changes. Write any index as a CREATE INDEX statement.

If the query can be rewritten better, end with the improved query in one sql code block. If it is already good, say so and add no code block.

Schema:
${schema}

Query:
${block(sql)}
${plan ? `\nPlan:\n\`\`\`\n${plan.slice(0, 6000)}\n\`\`\`` : ''}`;
}

export function fix(sql: string, error: string, schema: string): string {
  return `This query failed.

Error:
\`\`\`
${error}
\`\`\`

Answer in exactly this shape:
**Cause:** one sentence.

Then the corrected query in one sql code block. Keep the original intent, formatting and comments.

Schema:
${schema}

Query:
${block(sql)}`;
}

export function explainResult(sql: string, csv: string, total: number): string {
  return `Describe what this result shows.

Answer with:
- 2 to 5 bullets with concrete numbers from the data.
- One last bullet on anything odd (nulls, outliers, duplicates), only if there is something.

Query:
${block(sql)}

First rows of ${total.toLocaleString('en-US')} (CSV):
\`\`\`
${csv}
\`\`\``;
}

export function generate(request: string, schema: string): string {
  return `Write one query for this request:
"${request.trim()}"

Answer with one short sentence on how the query works, then the SQL in one sql code block. If the request needs several statements (for example a CREATE TABLE, then a query that uses it), put all of them in that block, in order.
Use the exact table and column names from the schema below. If the request needs a table or column that is not in it, do not guess: say which one is missing and write no query, unless the request is to create it.

Schema:
${schema}`;
}

/** The last ```sql block of an answer, if any. */
export function extractSql(markdown: string): string | undefined {
  const blocks = [...markdown.matchAll(/```(?:sql|mysql|postgresql|tsql|sqlite)?\s*\n([\s\S]*?)```/gi)];
  const last = blocks.at(-1)?.[1]?.trim();
  return last || undefined;
}

/** Hides reasoning that some local models print as <think>...</think>. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');
}
