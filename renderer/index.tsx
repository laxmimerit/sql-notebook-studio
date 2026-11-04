import type { ActivationFunction } from 'vscode-notebook-renderer';
import { createRoot, type Root } from 'react-dom/client';
import { AI_MIME, type AiPayload, type RendererMessage, type ResultPayload } from '../shared/protocol';
import { ResultView } from './Result';
import { AiView } from './AiView';
import { setPoster } from './util';
import css from './styles.css';

const roots = new Map<string, { root: Root; el: HTMLElement }>();

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

export const activate: ActivationFunction = (ctx) => {
  injectStyles();
  setPoster(ctx.postMessage ? (m: RendererMessage) => ctx.postMessage!(m) : undefined);
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
    },
    disposeOutputItem(id) {
      if (id) {
        roots.get(id)?.root.unmount();
        roots.delete(id);
      } else {
        roots.forEach((r) => r.root.unmount());
        roots.clear();
      }
    },
  };
};
