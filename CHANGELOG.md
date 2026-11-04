# Changelog

## 1.0.0

First release.

- `.sqlnb` notebooks with SQL, Markdown and AI cells. Results can be saved in the file.
- MySQL / MariaDB, PostgreSQL, SQL Server, plus built-in SQLite and DuckDB.
- SSL/TLS and SSH tunnels. Passwords are kept in VS Code's secret storage.
- Connection explorer with tables and columns, Select Top 100 and Describe.
- Autocomplete for tables, columns, aliases and keywords.
- Results grid: virtual scrolling, sort, filter, resize, pin, copy, CSV/JSON export.
- Quick charts: bar, line, area, scatter and pie.
- `{{variables}}` and `${env:NAME}` in queries.
- Run several statements per cell; Stop works on every database.
- Safety: confirm DROP, TRUNCATE and UPDATE/DELETE without WHERE; read-only connections.
- AI through LangChain: OpenAI, Anthropic, OpenRouter, Ollama or any OpenAI-compatible API.
  Explain, optimize, fix errors, explain results, and AI cells that write SQL.
- Export to HTML, PDF and Markdown.
