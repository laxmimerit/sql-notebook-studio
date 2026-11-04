// Bundles the extension host code, the lazily loaded drivers and AI layer,
// the notebook renderer and the connection form webview.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/media', { recursive: true });
cpSync('node_modules/@vscode/codicons/dist/codicon.css', 'dist/media/codicon.css');
cpSync('node_modules/@vscode/codicons/dist/codicon.ttf', 'dist/media/codicon.ttf');
cpSync('node_modules/chart.js/dist/chart.umd.min.js', 'dist/media/chart.umd.js');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
  legalComments: 'none',
};

const nodeExternals = ['vscode', '@duckdb/node-api', '@duckdb/node-bindings', 'pg-native', 'cpu-features', '*.node'];

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: {
      extension: 'src/extension.ts',
      sqliteWorker: 'src/db/drivers/sqliteWorker.ts',
      'drivers/mysql': 'src/db/drivers/mysql.ts',
      'drivers/postgres': 'src/db/drivers/postgres.ts',
      'drivers/mssql': 'src/db/drivers/mssql.ts',
      'drivers/duckdb': 'src/db/drivers/duckdb.ts',
      'drivers/sqlite': 'src/db/drivers/sqlite.ts',
      tunnel: 'src/db/tunnel.ts',
      ai: 'src/ai/models.ts',
    },
    outdir: 'dist',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: nodeExternals,
    mainFields: ['module', 'main'],
  }),
  esbuild.context({
    ...common,
    entryPoints: { renderer: 'renderer/index.tsx' },
    outdir: 'dist',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    loader: { '.css': 'text' },
    define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  }),
  esbuild.context({
    ...common,
    entryPoints: { webview: 'webview/index.tsx' },
    outdir: 'dist',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    loader: { '.css': 'text' },
    define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
