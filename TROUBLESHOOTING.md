# Troubleshooting

Answers to the problems people run into most. Find your error message below,
or the database you use. If nothing here helps,
[open an issue](https://github.com/laxmimerit/sql-notebook-studio/issues/new/choose)
with the exact error message.

- [Installing](#installing)
- [How connections work](#how-connections-work)
- [All databases](#all-databases)
- [SQL Server](#sql-server)
- [MySQL / MariaDB](#mysql--mariadb)
- [PostgreSQL](#postgresql)
- [SQLite and DuckDB](#sqlite-and-duckdb)
- [Autocomplete and capital keywords](#autocomplete-and-capital-keywords)
- [AI](#ai)
- [Reporting a bug](#reporting-a-bug)

## Installing

### Cursor, Windsurf, VSCodium or another VS Code-based editor can't find it

These editors don't use Microsoft's Marketplace; they search Open VSX, and
SQL Notebook Studio is not published there. Install it from a file instead:

1. Download the package for your system from the
   [latest release](https://github.com/laxmimerit/sql-notebook-studio/releases/latest)
   (the table in the [README](README.md#install) says which one).
2. In the editor, open the Command Palette and run **Extensions: Install from
   VSIX…**, or drag the file onto the Extensions view.

It works the same as in VS Code (tested in Cursor). A file install doesn't
update itself: download the new file when a new version comes out.

### "The extension is not available in Visual Studio Code for the … platform"

The Marketplace checks each platform's package separately after a release, so
for a few hours a new version can be installable on some systems and not yet on
yours. Wait and try again, or install the file from the
[latest release](https://github.com/laxmimerit/sql-notebook-studio/releases/latest).

### Which file is mine?

- **Windows:** `win32-x64` on almost every PC; `win32-arm64` only on ARM
  laptops (for example Snapdragon). Settings → System → About → System type.
- **Mac:** Apple menu → About This Mac. "Chip: Apple M…" means `darwin-arm64`;
  "Processor: Intel" means `darwin-x64`.
- **Linux:** `linux-x64`, or `linux-arm64` on ARM (`uname -m` prints
  `aarch64`). Alpine Linux uses the `alpine-` files.

Each file carries the DuckDB engine built for one system. If the editor says
the extension isn't compatible with your platform, you have the wrong file.

### Every button shows twice, or a connection is missing from the sidebar

An old test copy of the extension, **kgptalkie.sql-notebook** (from a file
named `sql-notebook-<system>-1.0.0.vsix`), is installed next to SQL Notebook
Studio. The two copies keep separate connection lists, so you can see:

- each toolbar and sidebar button twice, and each built-in database twice in
  the connection picker;
- a notebook running on a connection that the sidebar doesn't list;
- "You already have a connection named …" for a name the sidebar doesn't show.

Version 1.0.1 and later warn about this and offer **Uninstall Old Copy**.
Or remove it yourself: in the Extensions view, uninstall the SQL Notebook
Studio entry whose ID (shown on its page) is `kgptalkie.sql-notebook`, keep
`kgptalkie.sql-notebook-studio`, and reload the window. Connections saved only
in the old copy need to be added again.

### "You already have a connection named …"

Connection names must be unique. A new connection is named after its server,
for example *SQL Server · localhost*; from version 1.0.1, if that name
is taken, the form picks *SQL Server · localhost (2)*. To use the server you already saved,
pick that connection in the sidebar or the notebook's connection picker
instead of adding it again. Seeing this for a name the sidebar doesn't list
means an old copy is installed: see above.

### `code: command not found`

The terminal command isn't set up. On a Mac, open the Command Palette in VS
Code and run **Shell Command: Install 'code' command in PATH**, then open a new
terminal. On Windows, reinstall VS Code with "Add to PATH" ticked, or use
**Install from VSIX…** inside VS Code instead.

### After uninstalling, VS Code keeps asking where to save a notebook

Open notebooks that were never saved stay open when the extension is removed,
and VS Code asks to save each one. Click **Cancel**, then **Restart Anyway**
when VS Code asks to restart its extensions. Save the notebooks you want to
keep before uninstalling.

## How connections work

Knowing this answers many questions below.

- **Each open notebook has its own connection** to each database it uses. So
  `USE`, `SET`, temp tables and open transactions stay in that notebook and
  never leak into another one.
- **The sidebar has one more connection** of its own, shared by the table
  list, autocomplete and the AI. It always shows the database set in the
  connection, not the one a notebook switched to with `USE`.
- So **two open notebooks on one server use three connections.** Closing a
  notebook closes its connection.
- **Built-in in-memory databases** (*Scratch SQLite*, *Scratch DuckDB*) are the
  exception: every notebook and the sidebar share one, so they all see the
  same tables.
- A connected connection has a **green name and ●** in the sidebar. A **!**
  means the last attempt failed; hover over it to read why.

## All databases

**The sidebar says "Can't connect: Connection lost", but my cells run fine.**
The sidebar uses its own connection (see above). If the server restarted or
the PC slept, that connection broke. It now reconnects by itself, and running
any cell on that connection clears the message. If the message stays, click
**↻ Refresh** at the top of the view.

**"Connection lost", "ECONNRESET", "socket hang up" after my PC slept or the server restarted.**
Run the cell again. A cell that finds its connection lost reconnects once and
retries by itself. If it fails again, the server is refusing new connections:
see the SQL Server section for one cause, or check that the server is running.

**"ECONNREFUSED" or "Could not connect".**
Nothing is listening at that host and port. Check that the database service is
running, that the port is right, and that a firewall is not blocking it. **Test
Connection** in the connection form tells you at once.

**"ETIMEDOUT" or it hangs while connecting.**
The host can't be reached: a wrong address, a VPN you are not on, or a firewall
that drops packets. For a server only reachable through another machine, turn
on **SSH tunnel** in the connection form.

**A query runs forever.**
Click **Stop** on the cell. To stop long queries automatically, set
`sqlNotebook.queryTimeoutSeconds` (0, the default, means no limit).

**I only see 10,000 rows.**
Results keep at most `sqlNotebook.results.maxRows` rows (default 10,000). Raise
it in settings, or add `LIMIT` / `TOP` to the query.

**I created a table, but the sidebar doesn't show it.**
Click **↻ Refresh**. `CREATE`, `DROP`, `ALTER` and `USE` run in a cell refresh
the table list by themselves; other changes show within 5 minutes.

## SQL Server

**Only one notebook can connect at a time. The second fails until I restart SQL Server, and then the first one says "Connection lost".**
SQL Server is refusing extra connections. Remember that each notebook and the
sidebar have their own connection, so the sidebar often fails too. Check, in
this order, by running these in the notebook that works:

1. **You are on port 1434, the admin port.** Port 1434 is SQL Server's
   *Dedicated Admin Connection*, which allows **only one connection at a
   time**. The normal port is **1433**. (People type 1434 because the *SQL
   Server Browser* service uses that number.)
   ```sql
   SELECT e.name AS endpoint, c.local_tcp_port
   FROM sys.dm_exec_connections c
   JOIN sys.endpoints e ON e.endpoint_id = c.endpoint_id
   WHERE c.session_id = @@SPID;
   ```
   If `endpoint` is *Dedicated Admin Connection* or the port is 1434, edit the
   connection (right-click → **Edit Connection**), set the port to **1433** or
   leave it empty, and save.
2. **The server allows only a few connections.** `value_in_use` should be
   **0** (no limit):
   ```sql
   SELECT name, value_in_use FROM sys.configurations WHERE name = 'user connections';
   ```
   To fix, run the lines below, then restart the SQL Server service:
   ```sql
   EXEC sp_configure 'show advanced options', 1; RECONFIGURE;
   EXEC sp_configure 'user connections', 0; RECONFIGURE;
   ```
3. **The server runs in single-user mode.** This returns 1 if so:
   ```sql
   SELECT SERVERPROPERTY('IsSingleUser') AS single_user;
   ```
   In *SQL Server Configuration Manager* → *SQL Server Services* →
   right-click *SQL Server* → *Properties* → *Startup Parameters*, remove `-m`,
   then restart the service.
4. **Still not found?** Right after the second notebook fails, read SQL
   Server's own reason:
   ```sql
   EXEC xp_readerrorlog 0, 1, N'connect';
   ```

**"Failed to connect to localhost:1433" on a local SQL Server (often Express).**
TCP/IP is turned off. Express installs with it off. Open *SQL Server
Configuration Manager* → *SQL Server Network Configuration* → *Protocols for
…* → enable **TCP/IP**, then restart the SQL Server service.

**I use a named instance such as `localhost\SQLEXPRESS`.**
Put the host in **Host** and the instance name (`SQLEXPRESS`) in **Instance**,
and leave the port empty. The *SQL Server Browser* service must be running so
the instance's port can be found. If you set a fixed TCP port for the instance
instead, use that port and leave **Instance** empty.

**"self-signed certificate" or "certificate verify failed".**
A local or development server has a certificate your PC doesn't trust. Turn on
**Trust server certificate** in the connection form. Do this only for servers
you know; for production, install a trusted certificate on the server instead.

**"Login failed for user 'sa'".**
Check the password first. Then check that the server allows SQL logins: in
SSMS, right-click the server → *Properties* → *Security* → choose *SQL Server
and Windows Authentication mode*, then restart the service. The `sa` login may
also be disabled: `ALTER LOGIN sa ENABLE;`

**Windows sign-in.**
Choose **Windows (NTLM)** and enter your Windows user name, password and
domain. It can't sign in silently as the current Windows user.

## MySQL / MariaDB

**"Access denied for user 'root'@'localhost'".**
The password is wrong, or that user may only sign in from another host.
Check `SELECT user, host FROM mysql.user;` as an admin.

**"Too many connections".**
The server reached `max_connections`. Each open notebook uses one connection,
plus one for the sidebar. Close notebooks you don't need, or raise the limit:
`SET GLOBAL max_connections = 300;`

**I don't see any tables.**
If the connection has no database set, the sidebar lists every database:
expand one. In a cell, run `USE shop;` or write `shop.orders`.

## PostgreSQL

**"no pg_hba.conf entry for host".**
The server doesn't accept connections from your address, or requires SSL. Turn
on **Use SSL** in the connection form, or ask the server's admin to add your
address to `pg_hba.conf`.

**"The server does not support SSL connections".**
Turn off **Use SSL** in the connection form.

**"password authentication failed".**
Check the user name and password. Names are case-sensitive.

**My table is in another schema.**
When a database has more than one schema, the sidebar lists them all: expand
one. In a cell, write
`myschema.mytable` or run `SET search_path TO myschema;`.

## SQLite and DuckDB

**My tables disappeared from *Scratch SQLite* / *Scratch DuckDB*.**
In-memory databases are emptied when VS Code closes. To keep tables, add a
connection that points to a file.

**"database is locked" (SQLite) or "Could not set lock on file" (DuckDB).**
Another program has the file open for writing. Close it there, or open a copy.

## Autocomplete and capital keywords

**No tables or columns are suggested.**
The cell needs a connection: check the notebook toolbar. Columns are suggested
for tables named in the cell (after `FROM`, `JOIN`, `UPDATE` or `INTO`), and
after `alias.` or `table.`. If you just created the table, click **↻ Refresh**.

**Keywords are suggested, but not my tables (SQL Server or MySQL).**
Autocomplete looks in the database the cell is in. Up to 1.0.1 it used the
database saved in the connection, so with that field empty it looked in
`master` (SQL Server) or nowhere (MySQL), even after `USE MyDatabase`. From
1.0.2 it follows `USE`: in the same cell, in an earlier cell, or the one the
notebook last ran. On 1.0.1 or earlier, put the database in the connection's
**Database** field (right-click the connection → **Edit Connection**).

**A word turned into capitals when it shouldn't.**
Press **Ctrl+Z** once to put it back. Names that exist in your database are
never changed. To turn it off, run **SQL Notebook Studio: Toggle Uppercase
Keywords** or untick `sqlNotebook.editor.uppercaseKeywords`.

## AI

### The AI's answers are poor: choose a stronger model

**The answers are only as good as the model you choose.** SQL Notebook Studio
sends every model the same instructions and the same table and column names.
If explanations are vague, fixes don't work or the SQL uses columns that don't
exist, the cause is the model set in the AI settings, not SQL Notebook Studio.
Run **SQL Notebook Studio: Configure AI** and pick a stronger model.

**Local models (Ollama): use about 27B parameters or more.**

- Small models, around 4B to 8B parameters, are not good enough for this. They
  misread the schema, make up column names and give shallow explanations.
- Models of about 27B to 32B parameters work well, for example the 27B to 32B
  versions of Gemma or Qwen.
- They need a strong computer: roughly 16 to 20 GB of GPU memory, or a Mac with
  32 GB of memory or more. On less, they run very slowly or not at all.
- If your computer can't run a model that size, use an AI API instead (below).
  Many have a free tier.

**Free AI APIs.** These are enough for learning and everyday use. Their limits
and model lists change often, so check each site for the current ones.

| Service | Get a free key | In Configure AI |
| --- | --- | --- |
| [OpenRouter](https://openrouter.ai) | [openrouter.ai/keys](https://openrouter.ai/keys) | Provider **OpenRouter**. Pick a large model whose name ends in `:free`. |
| [Google Gemini](https://ai.google.dev) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Provider **Custom (OpenAI-compatible)**, base URL `https://generativelanguage.googleapis.com/v1beta/openai/`, then a Gemini Flash model. |
| [xAI Grok](https://x.ai/api) | [console.x.ai](https://console.x.ai) | Provider **Custom (OpenAI-compatible)**, base URL `https://api.x.ai/v1`, then a Grok model. Pay as you go; new accounts may get free starting credits. |
| [NVIDIA NIM](https://build.nvidia.com) | [build.nvidia.com](https://build.nvidia.com) (profile → API Keys) | Provider **Custom (OpenAI-compatible)**, base URL `https://integrate.api.nvidia.com/v1` |

With **Custom (OpenAI-compatible)**, enter the base URL, paste the key, and the
model list loads from the service. The same rule applies there: choose one of
the larger models, not the smallest. For more options, search the web for
"free LLM API".

> Free tiers may use what you send to improve their models. SQL Notebook
> Studio sends your table and column names, and result rows only when you
> allow it. For confidential databases, use a paid API or a local model.

**Paid AI APIs** give the best answers: **OpenAI**, **Anthropic**, or the paid
models on **OpenRouter**, all built into Configure AI.

### Other AI problems

**The AI uses table or column names that don't exist ("The query assumes…").**
The AI only knows the tables it is shown, and it is shown the database the
notebook is in. Up to 1.0.2, a SQL Server connection with no database set
showed it `master`, so even a 550B model guessed names like `FirstName`. From
1.0.3 it also shows any database your request names ("the persons table of
MyDatabase"), list the user databases when the notebook is still in `master`,
and tell the model to say a table is missing instead of guessing. On 1.0.2 or
earlier: run `USE MyDatabase;` in a cell first, or set **Database** in the
connection.

**"… cannot use tools, so it answered without checking the database".**
Agent mode (the default for AI cells and Fix with AI) needs a model that can
call tools. This model can't, so the answer was made the direct way, without
looking up tables or checking the SQL. Pick a model with tool calling: on
Ollama, `ollama show <model>` lists `tools` under Capabilities; on OpenRouter,
filter models by "Tools". Or set `sqlNotebook.ai.mode` to `direct` to stop the
note.

**The AI card says "Step limit reached".**
The agent may call the model at most 10 times per answer. When it runs out, it
answers with what its tools found so far. Small models sometimes loop on the
same lookup; a stronger model, or a more specific request ("the persons table
in MyDatabase"), usually fixes it.

**Why does the generated SQL hold a CREATE TABLE as well as the query?**
When the request needs a new table first, the agent puts every statement in one
cell, in order, because the query fails without the table. Run the cell once;
the CREATE TABLE fails if the table already exists.

**AI with Ollama fails or never answers ("fetch failed", "ECONNREFUSED").**
Start Ollama (`ollama serve`). Run **SQL Notebook Studio: Configure AI** and
check that the address is `http://localhost:11434` and that the model is pulled
(`ollama pull <model>`).

**"401", "invalid API key" or "AI is not set up yet".**
Run **SQL Notebook Studio: Configure AI** and enter the key again. Keys are
kept in VS Code's secret storage, never in settings files.

## Reporting a bug

[Open an issue](https://github.com/laxmimerit/sql-notebook-studio/issues/new/choose)
with:

- the exact error message (a screenshot is fine);
- the database and its version, for example *SQL Server 2022 Express*;
- the extension and VS Code versions (*Help → About*) and your OS.

Remove passwords, host names and other private data first.
