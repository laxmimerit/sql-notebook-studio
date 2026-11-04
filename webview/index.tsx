import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import css from './form.css';
import type { ConnectionConfig, DriverId, EnvTag, Secrets } from '../src/db/types';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();
const driversBase = document.getElementById('root')!.dataset.drivers!;

const DRIVERS: { id: DriverId; label: string; port?: number; file?: boolean }[] = [
  { id: 'mysql', label: 'MySQL', port: 3306 },
  { id: 'postgres', label: 'PostgreSQL', port: 5432 },
  { id: 'mssql', label: 'SQL Server', port: 1433 },
  { id: 'sqlite', label: 'SQLite', file: true },
  { id: 'duckdb', label: 'DuckDB', file: true },
];
const ENVS: { id: EnvTag; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'dev', label: 'Dev' },
  { id: 'staging', label: 'Staging' },
  { id: 'production', label: 'Production' },
];

type Has = { password: boolean; sshPassword: boolean; sshPassphrase: boolean };
type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; text: string };

function blank(name: string): ConnectionConfig {
  return { id: '', name, driver: 'mysql', host: 'localhost', port: 3306, user: '', database: '', env: 'none' };
}

function App() {
  const [conn, setConn] = useState<ConnectionConfig | null>(null);
  const [isNew, setIsNew] = useState(true);
  const [has, setHas] = useState<Has>({ password: false, sshPassword: false, sshPassphrase: false });
  const [secrets, setSecrets] = useState<Partial<Secrets>>({});
  const [folders, setFolders] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' });
  const [paste, setPaste] = useState<string | null>(null);
  const nameTouched = useRef(false);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'init') {
        setIsNew(!m.conn);
        setConn(m.conn ?? blank(m.suggestedName));
        nameTouched.current = !!m.conn;
        setHas(m.has);
        setFolders(m.folders);
      } else if (m.type === 'testResult') setStatus({ kind: m.ok ? 'ok' : 'error', text: m.message });
      else if (m.type === 'error') setStatus({ kind: 'error', text: m.message });
      else if (m.type === 'clipboard') setPaste((p) => (p === '' ? m.text : p));
      else if (m.type === 'browsed') setField(m.field, m.path);
      else if (m.type === 'parsed') {
        setConn((c) => ({ ...c!, ...m.config, port: m.config.port ?? DRIVERS.find((d) => d.id === (m.config.driver ?? c!.driver))?.port }));
        if (m.password !== undefined) setSecrets((s) => ({ ...s, password: m.password }));
        setPaste(null);
        setStatus({ kind: 'ok', text: 'Filled in from the connection string.' });
      }
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const setField = (path: string, value: unknown) =>
    setConn((c) => {
      if (!c) return c;
      const next: any = structuredClone(c);
      const keys = path.split('.');
      let o = next;
      for (const k of keys.slice(0, -1)) o = o[k] ??= {};
      o[keys.at(-1)!] = value;
      return next;
    });

  const driver = useMemo(() => DRIVERS.find((d) => d.id === conn?.driver)!, [conn?.driver]);

  // A new connection is named after what it points at, until the user types a name.
  useEffect(() => {
    if (!conn || !isNew || nameTouched.current) return;
    const d = DRIVERS.find((x) => x.id === conn.driver)!;
    const where = d.file
      ? (conn.file && conn.file !== ':memory:' ? conn.file.split(/[\\/]/).pop() : 'in memory')
      : `${conn.host || 'localhost'}${conn.database ? '/' + conn.database : ''}`;
    const name = `${d.label} · ${where}`;
    if (name !== conn.name) setField('name', name);
  }, [conn?.driver, conn?.host, conn?.database, conn?.file, isNew]);

  if (!conn) return null;

  const pickDriver = (id: DriverId) => {
    const d = DRIVERS.find((x) => x.id === id)!;
    setConn((c) => {
      const next: ConnectionConfig = { ...c!, driver: id };
      if (!d.file) {
        const oldDefault = DRIVERS.find((x) => x.id === c!.driver)?.port;
        if (!c!.port || c!.port === oldDefault) next.port = d.port;
        next.host ||= 'localhost';
        if (id === 'mssql') next.mssql ??= { auth: 'sql', encrypt: true, trustServerCertificate: true };
      }
      return next;
    });
  };

  const payload = () => {
    const c = structuredClone(conn);
    if (driver.file) {
      delete c.host; delete c.port; delete c.user; delete c.database; delete c.ssl; delete c.ssh; delete c.mssql;
      c.file ||= ':memory:';
    } else {
      delete c.file;
      c.port = Number(c.port) || driver.port;
      if (c.driver !== 'mssql') delete c.mssql;
    }
    return c;
  };

  const test = () => {
    setStatus({ kind: 'busy', text: 'Connecting…' });
    vscode.postMessage({ type: 'test', conn: payload(), secrets });
  };
  const save = () => {
    setStatus({ kind: 'busy', text: 'Saving…' });
    vscode.postMessage({ type: 'save', conn: payload(), secrets });
  };
  const browse = (field: string, filters?: Record<string, string[]>, saveDialog = false) =>
    vscode.postMessage({ type: 'browse', field, filters, save: saveDialog, title: 'Choose a file' });

  const sshOn = !!conn.ssh?.enabled;
  const sslOn = !!conn.ssl?.enabled;

  return (
    <form
      className="page"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <header>
        <h1>{isNew ? 'New connection' : 'Edit connection'}</h1>
        {!driver.file && (
          <button type="button" className="link" onClick={() => {
              setPaste(paste === null ? '' : null);
              if (paste === null) vscode.postMessage({ type: 'clipboard' });
            }}>
            <i className="codicon codicon-clippy" /> Paste connection string
          </button>
        )}
      </header>

      {paste !== null && (
        <div className="paste">
          <input
            autoFocus
            placeholder="mysql://user:pass@host:3306/db   ·   postgres://…   ·   Server=…;Database=…"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                vscode.postMessage({ type: 'parse', text: paste });
              }
            }}
          />
          <button type="button" className="secondary" onClick={() => vscode.postMessage({ type: 'parse', text: paste })}>
            Fill in
          </button>
        </div>
      )}

      <div className="drivers" role="radiogroup" aria-label="Database">
        {DRIVERS.map((d) => (
          <button type="button" role="radio" aria-checked={conn.driver === d.id} key={d.id} className={conn.driver === d.id ? 'driver on' : 'driver'} onClick={() => pickDriver(d.id)}>
            <img src={`${driversBase}/${d.id}.svg`} alt="" />
            <span>{d.label}</span>
          </button>
        ))}
      </div>

      <div className="grid">
        <Field label="Name">
          <input
            required
            value={conn.name}
            onChange={(e) => {
              nameTouched.current = true;
              setField('name', e.target.value);
            }}
          />
        </Field>
        <Field label="Folder" optional>
          <input list="folders" value={conn.folder ?? ''} placeholder="None" onChange={(e) => setField('folder', e.target.value)} />
          <datalist id="folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
        </Field>

        {driver.file ? (
          <Field label="Database file" wide hint="Leave empty for an in-memory database.">
            <div className="row">
              <input value={conn.file === ':memory:' ? '' : conn.file ?? ''} placeholder=":memory:" onChange={(e) => setField('file', e.target.value)} />
              <button type="button" className="secondary icon" title="Open existing file" onClick={() => browse('file', conn.driver === 'duckdb' ? { DuckDB: ['duckdb', 'ddb', 'db'], All: ['*'] } : { SQLite: ['db', 'sqlite', 'sqlite3', 'db3'], All: ['*'] })}>
                <i className="codicon codicon-folder-opened" />
              </button>
              <button type="button" className="secondary icon" title="Create a new file" onClick={() => browse('file', undefined, true)}>
                <i className="codicon codicon-new-file" />
              </button>
            </div>
          </Field>
        ) : (
          <>
            <Field label="Host">
              <input value={conn.host ?? ''} placeholder="localhost" onChange={(e) => setField('host', e.target.value)} />
            </Field>
            <Field label="Port">
              <input type="number" value={conn.port ?? ''} placeholder={String(driver.port)} onChange={(e) => setField('port', e.target.value ? Number(e.target.value) : undefined)} />
            </Field>
            {!(conn.driver === 'mssql' && conn.mssql?.auth === 'azure-default') && (
              <>
                <Field label="User">
                  <input value={conn.user ?? ''} autoComplete="off" onChange={(e) => setField('user', e.target.value)} />
                </Field>
                <Field label="Password">
                  <Secret value={secrets.password} saved={has.password} onChange={(v) => setSecrets((s) => ({ ...s, password: v }))} />
                </Field>
              </>
            )}
            <Field label="Database" optional wide={conn.driver !== 'mssql'}>
              <input value={conn.database ?? ''} placeholder={conn.driver === 'mysql' ? 'Browse all databases' : conn.driver === 'postgres' ? 'postgres' : 'master'} onChange={(e) => setField('database', e.target.value)} />
            </Field>
            {conn.driver === 'mssql' && (
              <Field label="Instance" optional>
                <input value={conn.mssql?.instanceName ?? ''} placeholder="Default" onChange={(e) => setField('mssql.instanceName', e.target.value)} />
              </Field>
            )}
          </>
        )}
      </div>

      {conn.driver === 'mssql' && (
        <Section title="Sign-in" icon="account" open>
          <Segmented
            value={conn.mssql?.auth ?? 'sql'}
            options={[
              { id: 'sql', label: 'SQL login' },
              { id: 'ntlm', label: 'Windows (NTLM)' },
              { id: 'azure-default', label: 'Microsoft Entra' },
            ]}
            onChange={(v) => setField('mssql.auth', v)}
          />
          {conn.mssql?.auth === 'ntlm' && (
            <div className="grid">
              <Field label="Domain">
                <input value={conn.mssql?.domain ?? ''} onChange={(e) => setField('mssql.domain', e.target.value)} />
              </Field>
            </div>
          )}
          {conn.mssql?.auth === 'azure-default' && <p className="hint">Uses your Azure CLI, VS Code or environment sign-in.</p>}
          <div className="toggles">
            <Toggle label="Encrypt" checked={conn.mssql?.encrypt ?? true} onChange={(v) => setField('mssql.encrypt', v)} />
            <Toggle label="Trust server certificate" checked={conn.mssql?.trustServerCertificate ?? false} onChange={(v) => setField('mssql.trustServerCertificate', v)} />
          </div>
        </Section>
      )}

      {!driver.file && conn.driver !== 'mssql' && (
        <Section title="SSL / TLS" icon="lock" badge={sslOn ? 'On' : undefined}>
          <div className="toggles">
            <Toggle label="Use SSL" checked={sslOn} onChange={(v) => setField('ssl', { ...(conn.ssl ?? {}), enabled: v, rejectUnauthorized: conn.ssl?.rejectUnauthorized ?? true })} />
            {sslOn && <Toggle label="Verify server certificate" checked={conn.ssl?.rejectUnauthorized ?? true} onChange={(v) => setField('ssl.rejectUnauthorized', v)} />}
          </div>
          {sslOn && (
            <div className="grid">
              {(['ca', 'cert', 'key'] as const).map((k) => (
                <Field key={k} label={k === 'ca' ? 'CA certificate' : k === 'cert' ? 'Client certificate' : 'Client key'} optional wide>
                  <div className="row">
                    <input value={conn.ssl?.[k] ?? ''} placeholder="Path to .pem" onChange={(e) => setField(`ssl.${k}`, e.target.value)} />
                    <button type="button" className="secondary icon" title="Browse" onClick={() => browse(`ssl.${k}`)}>
                      <i className="codicon codicon-folder-opened" />
                    </button>
                  </div>
                </Field>
              ))}
            </div>
          )}
        </Section>
      )}

      {!driver.file && (
        <Section title="SSH tunnel" icon="remote" badge={sshOn ? 'On' : undefined}>
          <div className="toggles">
            <Toggle label="Connect through SSH" checked={sshOn} onChange={(v) => setField('ssh', { host: '', user: '', port: 22, auth: 'password', ...(conn.ssh ?? {}), enabled: v })} />
          </div>
          {sshOn && (
            <>
              <div className="grid">
                <Field label="SSH host">
                  <input value={conn.ssh?.host ?? ''} onChange={(e) => setField('ssh.host', e.target.value)} />
                </Field>
                <Field label="SSH port">
                  <input type="number" value={conn.ssh?.port ?? 22} onChange={(e) => setField('ssh.port', Number(e.target.value) || 22)} />
                </Field>
                <Field label="SSH user">
                  <input value={conn.ssh?.user ?? ''} onChange={(e) => setField('ssh.user', e.target.value)} />
                </Field>
                <Field label="Sign in with">
                  <Segmented
                    value={conn.ssh?.auth ?? 'password'}
                    options={[
                      { id: 'password', label: 'Password' },
                      { id: 'key', label: 'Key file' },
                      { id: 'agent', label: 'Agent' },
                    ]}
                    onChange={(v) => setField('ssh.auth', v)}
                  />
                </Field>
                {conn.ssh?.auth === 'password' && (
                  <Field label="SSH password" wide>
                    <Secret value={secrets.sshPassword} saved={has.sshPassword} onChange={(v) => setSecrets((s) => ({ ...s, sshPassword: v }))} />
                  </Field>
                )}
                {conn.ssh?.auth === 'key' && (
                  <>
                    <Field label="Private key">
                      <div className="row">
                        <input value={conn.ssh?.keyFile ?? ''} placeholder="~/.ssh/id_ed25519" onChange={(e) => setField('ssh.keyFile', e.target.value)} />
                        <button type="button" className="secondary icon" title="Browse" onClick={() => browse('ssh.keyFile')}>
                          <i className="codicon codicon-folder-opened" />
                        </button>
                      </div>
                    </Field>
                    <Field label="Passphrase" optional>
                      <Secret value={secrets.sshPassphrase} saved={has.sshPassphrase} onChange={(v) => setSecrets((s) => ({ ...s, sshPassphrase: v }))} />
                    </Field>
                  </>
                )}
              </div>
              {conn.ssh?.auth === 'agent' && <p className="hint">Uses the running OpenSSH agent.</p>}
            </>
          )}
        </Section>
      )}

      <Section title="Safety" icon="shield" badge={conn.env && conn.env !== 'none' ? ENVS.find((e) => e.id === conn.env)?.label : conn.readOnly ? 'Read-only' : undefined}>
        <div className="field">
          <span className="label">Tag</span>
          <div className="chips">
            {ENVS.map((e) => (
              <button type="button" key={e.id} className={`chip env-${e.id} ${(conn.env ?? 'none') === e.id ? 'on' : ''}`} onClick={() => setField('env', e.id)}>
                {e.label}
              </button>
            ))}
          </div>
          {conn.env === 'production' && <p className="hint">You'll be asked before DROP, TRUNCATE, or DELETE/UPDATE without WHERE.</p>}
        </div>
        <div className="toggles">
          <Toggle label="Read-only (block changes)" checked={!!conn.readOnly} onChange={(v) => setField('readOnly', v)} />
        </div>
      </Section>

      <footer>
        <div className={`status ${status.kind}`} role="status" aria-live="polite">
          {status.kind === 'busy' && <i className="codicon codicon-loading codicon-modifier-spin" />}
          {status.kind === 'ok' && <i className="codicon codicon-pass-filled" />}
          {status.kind === 'error' && <i className="codicon codicon-error" />}
          <span>{status.text}</span>
        </div>
        <button type="button" className="secondary" onClick={() => vscode.postMessage({ type: 'cancel' })}>
          Cancel
        </button>
        <button type="button" className="secondary" onClick={test} disabled={status.kind === 'busy'}>
          <i className="codicon codicon-plug" /> Test
        </button>
        <button type="submit" disabled={status.kind === 'busy'}>Save</button>
      </footer>
    </form>
  );
}

function Field({ label, children, optional, wide, hint }: { label: string; children: ReactNode; optional?: boolean; wide?: boolean; hint?: string }) {
  return (
    <label className={wide ? 'field wide' : 'field'}>
      <span className="label">
        {label}
        {optional && <em>optional</em>}
      </span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function Secret({ value, saved, onChange }: { value?: string; saved: boolean; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="row">
      <input
        type={show ? 'text' : 'password'}
        autoComplete="new-password"
        value={value ?? ''}
        placeholder={saved ? '•••••••• saved' : ''}
        title="Tip: ${env:NAME} reads an environment variable"
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="secondary icon" title={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)}>
        <i className={`codicon codicon-${show ? 'eye-closed' : 'eye'}`} />
      </button>
    </div>
  );
}

function Section({ title, icon, children, badge, open }: { title: string; icon: string; children: ReactNode; badge?: string; open?: boolean }) {
  return (
    <details className="section" open={open}>
      <summary>
        <i className="codicon codicon-chevron-right chev" />
        <i className={`codicon codicon-${icon}`} />
        <span>{title}</span>
        {badge && <span className="badge">{badge}</span>}
      </summary>
      <div className="body">{children}</div>
    </details>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track"><span className="thumb" /></span>
      <span>{label}</span>
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button type="button" role="radio" aria-checked={value === o.id} key={o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const style = document.createElement('style');
style.textContent = css;
document.head.appendChild(style);
createRoot(document.getElementById('root')!).render(<App />);
