import type { ActivationFunction } from 'vscode-notebook-renderer';
import { createRoot, type Root } from 'react-dom/client';
import { AI_MIME, type AiPayload, type HostMessage, type RendererMessage, type ResultPayload } from '../shared/protocol';
import { lowerTop, placeAfterRun, settled } from './scroll';
import { ResultView } from './Result';
import { AiView } from './AiView';
import { setPoster } from './util';
import css from './styles.css';

const roots = new Map<string, { root: Root; el: HTMLElement }>();
/** Output element by our output id (payload id), for scroll measurements. */
const outputs = new Map<string, HTMLElement>();
/** VS Code's output item id to our output id. */
const ourIds = new Map<string, string>();
/** Our output ids whose query is still running. */
const running = new Set<string>();
/** Waiting for an output to be drawn before placing the cell that was run. */
let pendingPlace: Extract<HostMessage, { type: 'placeAfterRun' }> | undefined;
/** Goes up with every Shift+Enter, so an older placement never overrides a newer one. */
let placeGen = 0;

function injectStyles() {
  if (document.getElementById('sqlnb-styles')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./media/codicon.css', import.meta.url).toString();
  document.head.appendChild(link);
  const style = document.createElement('style');
  style.id = 'sqlnb-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

// VS Code learns an output's height from a ResizeObserver in the webview. When
// a result is replaced several times in quick succession (running, then done),
// VS Code can keep an early height, and the next cell then covers the result.
// The result does not change size again, so VS Code is never told. Check that
// the space VS Code gives matches the result, and if not, change the result's
// height by 1px for two frames so VS Code measures it again.
const watched = new WeakSet<HTMLElement>();
function keepHeightInSync(el: HTMLElement) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nudges = 0;
  const check = () => {
    const box = el.closest('.output_container') as HTMLElement | null;
    if (!box || !el.isConnected || el.nextElementSibling) return;
    if (Math.abs(box.offsetHeight - (el.offsetTop + el.offsetHeight)) <= 1) {
      nudges = 0;
      return;
    }
    if (nudges++ >= 3) return;
    el.style.minHeight = `${el.offsetHeight + 1}px`;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.style.minHeight = '';
        timer = setTimeout(check, 400);
      }),
    );
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(check, 400);
  };
  later();
  if (watched.has(el)) return;
  watched.add(el);
  new ResizeObserver(later).observe(el);
}

async function place(m: Extract<HostMessage, { type: 'placeAfterRun' }>, gen: number) {
  const el = outputs.get(m.outputId);
  if (!el?.isConnected) {
    pendingPlace = m;
    return;
  }
  pendingPlace = undefined;
  await settled(el, () => !running.has(m.outputId));
  if (gen !== placeGen) return; // a newer Shift+Enter came in
  await placeAfterRun(el, m.nextOutputId ? outputs.get(m.nextOutputId) : undefined, m.ratio, m.fit);
}

export const activate: ActivationFunction = (ctx) => {
  injectStyles();
  setPoster(ctx.postMessage ? (m: RendererMessage) => ctx.postMessage!(m) : undefined);
  ctx.onDidReceiveMessage?.((m: HostMessage) => {
    const quiet = (p: Promise<unknown>) => void p.catch(() => undefined);
    if (m.type === 'placeAfterRun') quiet(place(m, ++placeGen));
    else if (m.type === 'lowerTop') {
      placeGen++;
      pendingPlace = undefined;
      quiet(lowerTop(m.ratio));
    }
  });
  return {
    renderOutputItem(item, element) {
      let entry = roots.get(item.id);
      if (!entry || entry.el !== element) {
        entry?.root.unmount();
        entry = { root: createRoot(element), el: element };
        roots.set(item.id, entry);
      }
      const data = item.json() as AiPayload | ResultPayload;
      const id = data.id ?? item.id;
      if (item.mime === AI_MIME) entry.root.render(<AiView payload={data as AiPayload} outputId={id} />);
      else entry.root.render(<ResultView payload={data as ResultPayload} outputId={id} />);
      if ((data as ResultPayload).running) running.add(id);
      else running.delete(id);
      outputs.set(id, element);
      ourIds.set(item.id, id);
      keepHeightInSync(element);
      if (pendingPlace?.outputId === id) void place(pendingPlace, placeGen).catch(() => undefined);
    },
    disposeOutputItem(id) {
      if (id) {
        roots.get(id)?.root.unmount();
        roots.delete(id);
        const ours = ourIds.get(id);
        if (ours && outputs.get(ours) && !outputs.get(ours)!.isConnected) outputs.delete(ours);
        ourIds.delete(id);
      } else {
        roots.forEach((r) => r.root.unmount());
        roots.clear();
        outputs.clear();
        ourIds.clear();
      }
    },
  };
};
