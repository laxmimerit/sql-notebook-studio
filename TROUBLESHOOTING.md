# Troubleshooting

Answers to the problems people run into most. Find your error message below,
or the database you use. If nothing here helps,
[open an issue](https://github.com/laxmimerit/sql-notebook-studio/issues/new/choose)
with the exact error message.

- [How connections work](#how-connections-work)
- [All databases](#all-databases)
- [SQL Server](#sql-server)
- [MySQL / MariaDB](#mysql--mariadb)
- [PostgreSQL](#postgresql)
- [SQLite and DuckDB](#sqlite-and-duckdb)
- [Autocomplete and capital keywords](#autocomplete-and-capital-keywords)
- [AI](#ai)
- [Reporting a bug](#reporting-a-bug)

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

**A word turned into capitals when it shouldn't.**
Press **Ctrl+Z** once to put it back. Names that exist in your database are
never changed. To turn it off, run **SQL Notebook Studio: Toggle Uppercase
Keywords** or untick `sqlNotebook.editor.uppercaseKeywords`.

## AI

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
