# Changelog

## Unreleased

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
