// Replacing a cell's outputs without hitting VS Code's height bug, and the
// statement check that makes a second click close an open card.

import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { sameStatement } from '../shared/protocol';
import { setOutputs } from '../src/notebook/kernels';

const out = (id: string) => new vscode.NotebookCellOutput([], { sqlnbId: id });
const ids = (os: readonly { metadata?: Record<string, unknown> }[]) => os.map((o) => o.metadata?.sqlnbId);

function fake(current: string[]) {
  const calls: string[] = [];
  const cell = { outputs: current.map(out) } as unknown as vscode.NotebookCell;
  const exec = {
    replaceOutput: async (o: vscode.NotebookCellOutput[]) => void calls.push(`replace ${ids(o).join(',')}`),
    appendOutput: async (o: vscode.NotebookCellOutput[]) => void calls.push(`append ${ids(o).join(',')}`),
  } as unknown as vscode.NotebookCellExecution;
  return { cell, exec, calls };
}

describe('setOutputs', () => {
  it('replaces once when only the end changes', async () => {
    const a = fake(['r', 'f', 's']);
    await setOutputs(a.exec, a.cell, a.cell.outputs.slice(0, 2));
    expect(a.calls).toEqual(['replace r,f']);

    const b = fake(['r']);
    await setOutputs(b.exec, b.cell, [...b.cell.outputs, out('f')]);
    expect(b.calls).toEqual(['replace r,f']);
  });

  it('removes from the end, then appends, when an output in the middle goes', async () => {
    const f = fake(['r', 'f', 's']);
    const [r, , s] = f.cell.outputs;
    await setOutputs(f.exec, f.cell, [r, s]);
    expect(f.calls).toEqual(['replace r', 'append s']);
  });

  it('appends outputs that were there before as new copies', async () => {
    const f = fake(['r', 'f', 's']);
    const [r, , s] = f.cell.outputs;
    const kept: vscode.NotebookCellOutput[][] = [];
    (f.exec as unknown as { appendOutput: (o: vscode.NotebookCellOutput[]) => Promise<void> }).appendOutput = async (o) => void kept.push(o);
    await setOutputs(f.exec, f.cell, [r, s]);
    expect(kept[0][0]).not.toBe(s);
    expect(kept[0][0].metadata).toEqual(s.metadata);
  });

  it('replaces a card in the middle in place', async () => {
    const f = fake(['r', 'f', 's']);
    const [r, , s] = f.cell.outputs;
    await setOutputs(f.exec, f.cell, [r, out('f2'), s]);
    expect(f.calls).toEqual(['replace r', 'append f2,s']);
  });
});

describe('sameStatement', () => {
  it('ignores line endings, outer spaces and a final semicolon', () => {
    expect(sameStatement('SELECT 1\r\nFROM t;', '  SELECT 1\nFROM t  ')).toBe(true);
    expect(sameStatement('SELECT 1 ;\n', 'SELECT 1')).toBe(true);
  });

  it('tells different statements apart', () => {
    expect(sameStatement('SELECT 1', 'SELECT 2')).toBe(false);
    expect(sameStatement('SELECT a FROM t', 'SELECT a  FROM t')).toBe(false);
  });
});
