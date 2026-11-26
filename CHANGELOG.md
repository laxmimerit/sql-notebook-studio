# Changelog

## Unreleased

- **Query Flow** shows the order the database runs a statement in, which is not the order it is written in. Open it from the **Query Flow** button in a result's toolbar (next to Table/Chart), the icon in a SQL cell's toolbar, or **Show Query Flow** in the Command Palette. It asks the database's planner (EXPLAIN; the query itself does not run again) and lays the steps out in three panes: your SQL with numbered badges on the lines each step comes from, a middle panel that explains the current step in plain words (what it reads, what it passes on, the planner's row estimate), and a graph of how the steps feed each other. A "You write / It runs" strip compares the two orders. Play steps through them one at a time, or use Prev/Next, the arrow keys, or click a line, node, chip or progress segment. Works with PostgreSQL, SQLite and DuckDB.
- **Safer write checks.** "UPDATE/DELETE without WHERE" now looks only at the statement's own WHERE. Before, a WHERE inside a subquery, a string, a quoted name or a comment hid the warning, so `UPDATE users SET plan_id = (SELECT id FROM plans WHERE name = 'free')` changed every row with no confirmation on a Production connection.
- A write inside a CTE (`WITH gone AS (DELETE FROM orders RETURNING *) SELECT ...`) now counts as a write: read-only connections refuse it, and a DELETE or UPDATE there without WHERE asks first.
- Each statement of a SQL Server batch is checked on its own, when they are separated by `;`.
- The confirmation for `DROP TABLE IF EXISTS users` names the table (`DROP TABLE users`), not `DROP TABLE IF`.

## 1.2.1

- **Shift+Enter** keeps the cell you ran selected instead of moving to the next cell.

## 1.2.0

- **Shift+Enter** runs the cell, selects the next one and, once the result is drawn, puts the cell you ran one third of the way down the window, so the top third still shows the end of the cell above. New setting `sqlNotebook.shiftEnterScroll`: `top` (the cell you ran at the top), `topThird` (the default), `middle` (halfway down), `whenNeeded` (scroll only when the next cell would be hidden near the bottom) or `off`.
- **Ctrl+Enter** (Cmd+Enter on Mac) runs the cell where it is, without scrolling, as in Jupyter.
- **A** and **B** add a code cell above or below the selected cell (when no cell is being edited), as in Jupyter.
- A result no longer slides under the next cell. When a result was replaced quickly (running, then done), VS Code could keep the first, smaller height.

## 1.1.1

- Every cell's toolbar has an **Add AI Prompt Below** button (chat sparkle icon). VS Code keeps the "+ Code / + Markdown" row between cells to itself, so this is how to add a prompt right under a cell.
- An AI cell that answers without SQL (for example "the database has no tables", or a table is missing) now ends with ✓, not ✗. It ran fine; there was just no SQL to put below.

## 1.1.0

- AI cells and Fix with AI now work as an agent (LangChain `createAgent` with the to-do list middleware). For a task with several parts the model writes a plan first. It looks up databases, tables and columns with read-only tools, and checks its SQL against the database without running it (SQL Server: `SET NOEXEC ON` plus a table lookup; others: `EXPLAIN`). The final SQL is always checked once more; if that fails, the model fixes it, up to twice.
- The AI card shows the plan and the current step while the agent works. Once the answer is in, they fold into **How this answer was made**, with each tool's input and result.
- New setting `sqlNotebook.ai.mode`: `agent` (default) or `direct` (one call, no checks). Models without tool calling answer the direct way, with a note in the card. Explain, Optimize and Explain Result stay direct.
- The notebook toolbar's AI cell button is now **+ AI Prompt**, next to + Code and + Markdown.

## 1.0.3

- The AI sees the right tables on SQL Server. A database named in the request ("the persons table of MyDatabase") is described too, with three-part names. When the notebook is still in `master`, the user databases are described instead of `master`'s system tables. Before, the AI was shown `master` and guessed column names.
- The AI no longer guesses missing tables or columns: it says which one is missing.

## 1.0.2

- Autocomplete and the AI now look in the database the notebook switched to with `USE`, not only the one saved in the connection. Before, a SQL Server connection with no database set suggested `master`'s tables after `USE MyDatabase`, and MySQL suggested none. `USE` counts whether it is in the same cell, in an earlier cell, or already run.

## 1.0.1

- If an old test copy (`kgptalkie.sql-notebook`) is also installed, the extension now steps aside and offers to uninstall it. Before, every button showed twice and the two copies kept separate connection lists, so a connection could work in a notebook but be missing from the sidebar.
- A new connection's automatic name no longer clashes with a saved one: "SQL Server · localhost" becomes "SQL Server · localhost (2)". The "already used" message now says where the other connection is.

## 1.0.0

First release.

- `.sqlnb` notebooks with SQL, Markdown and AI cells. Results can be saved in the file.
- Licensed under Apache 2.0, with a NOTICE file. Third-party licenses are in THIRD-PARTY-NOTICES.txt.
- `.sqlnb` files have their own icon. One "SQL" cell type works for every database; the connection picks the dialect.
- MySQL / MariaDB, PostgreSQL, SQL Server, plus built-in SQLite and DuckDB.
- SSL/TLS and SSH tunnels. Passwords are kept in VS Code's secret storage.
- Connection explorer with tables and columns, Select Top 100 and Describe. A green ● marks connected connections. If a connection drops (server restart, sleep), the explorer reconnects on its own, and a cell that runs fine on a connection clears its "Can't connect" message.
- SQL keywords turn into capitals as you type, per database (keyword lists from sql-formatter). Names, strings and comments are left alone. Setting `sqlNotebook.editor.uppercaseKeywords`, on by default.
- The notebook toolbar shows the database type next to the connection, for example "Sample Shop · SQLite".
- Autocomplete for tables, columns, aliases and keywords. Fuzzy and case-blind (`slt` finds SELECT); keywords are inserted in uppercase (or lowercase, or as typed, in settings).
- Results grid: virtual scrolling, sort, filter, resize, pin, copy, CSV/JSON export.
- Quick charts: bar, line, area, scatter and pie.
- `{{variables}}` and `${env:NAME}` in queries.
- Run several statements per cell; Stop works on every database.
- Safety: confirm DROP, TRUNCATE and UPDATE/DELETE without WHERE; read-only connections.
- AI through LangChain: OpenAI, Anthropic, OpenRouter, Ollama or any OpenAI-compatible API.
  Explain, optimize, fix errors, explain results, and AI cells that write SQL.
- Export to HTML, PDF and Markdown.
