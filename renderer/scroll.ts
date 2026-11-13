// Scrolling the notebook from inside the results webview.
//
// VS Code gives extensions no way to scroll a notebook to an exact pixel
// position. Its output webview does pass mouse wheel events on to the
// notebook, and the notebook scrolls by a fixed share of the wheel delta. So a
// wheel event with a worked-out delta scrolls the notebook by an exact number
// of pixels. The move is relative, so it does not depend on where VS Code has
// put the webview inside the notebook (it shifts it at times).
//
// The visible part of the notebook is measured with an IntersectionObserver
// on an invisible, full-height marker: its intersection rectangle is the
// notebook viewport in webview coordinates.

let marker: HTMLElement | undefined;

export interface View {
  top: number;
  height: number;
}

/**
 * The visible notebook area, in webview coordinates. Rejects when the webview
 * is not being drawn (VS Code can keep it paused while no result is on
 * screen), so no caller waits forever.
 */
export function viewport(): Promise<View> {
  if (!marker) {
    marker = document.createElement('div');
    marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:100vh;opacity:0;pointer-events:none';
    document.body.appendChild(marker);
  }
  const m = marker;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      io.disconnect();
      reject(new Error('webview not drawn'));
    }, 500);
    const io = new IntersectionObserver((entries) => {
      clearTimeout(timer);
      io.disconnect();
      const r = entries[entries.length - 1].intersectionRect;
      resolve({ top: r.top, height: r.height });
    });
    io.observe(m);
  });
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// VS Code turns a wheel event into a scroll of wheelDeltaY / devicePixelRatio
// / 120 * 50 pixels (times the list scroll sensitivity), rounded away from
// zero. `gain` learns any other factor (a changed sensitivity setting).
const PX_PER_WHEEL = 50 / 120;
let gain = 1;

function wheelBy(px: number) {
  const want = px / gain;
  // Just under the exact value, so rounding away from zero lands on it.
  const exact = want - Math.sign(want) * 0.01;
  const delta = (-exact / PX_PER_WHEEL) * devicePixelRatio;
  const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, view: window });
  for (const k of ['wheelDeltaY', 'wheelDelta']) Object.defineProperty(ev, k, { value: delta });
  // Sent from the outputs container, so VS Code scrolls the notebook and no
  // scrollable part of a result.
  (document.getElementById('container') ?? document.body).dispatchEvent(ev);
}

/** Waits for a scroll to land and stop (a smooth scroll takes a few frames). */
async function landed(from: number): Promise<View> {
  await frame();
  await frame();
  let v = await viewport();
  for (let i = 0; i < 30; i++) {
    await frame();
    const next = await viewport();
    if (Math.abs(next.top - v.top) < 0.5 && (Math.abs(next.top - from) >= 0.5 || i >= 2)) return next;
    v = next;
  }
  return v;
}

async function move(top: number): Promise<void> {
  let v = await viewport();
  for (let i = 0; i < 4; i++) {
    const d = top - v.top;
    if (Math.abs(d) <= 1) return;
    wheelBy(d);
    const now = await landed(v.top);
    const moved = now.top - v.top;
    // It cannot scroll further that way (the start or end of the notebook).
    if (Math.abs(moved) < 1) return;
    const r = moved / d;
    // Going well past the target, or covering the same share of a second
    // step, means the scroll speed is not the default; a cut-short first step
    // may only be the end of the notebook.
    // Small differences are cells above changing height while scrolling.
    const off = Math.abs(moved - d) > 10;
    if (off && (r > 1.25 || (i > 0 && r > 0.1 && r < 0.8))) gain = Math.min(10, Math.max(0.1, gain * r));
    v = now;
  }
}

let queue: Promise<void> = Promise.resolve();

/** Scrolls so the viewport's top edge lands on webview y `top`. Scrolls run one at a time. */
export function scrollViewTo(top: number): Promise<void> {
  const run = queue.then(() => move(top));
  queue = run.catch(() => undefined);
  return run;
}

// ---------- Shift+Enter: put the cell that was run one third down ----------

/** Space VS Code leaves between the end of a cell's output and the next cell (default layout). */
const CELL_GAP = 24;
let gap = CELL_GAP;

/** Resolves once the output has stopped changing size and VS Code has given it its full height. */
export function settled(el: HTMLElement, isDone: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    let last = -1;
    let still = 0;
    const start = performance.now();
    const tick = () => {
      const box = el.closest('.output_container') as HTMLElement | null;
      const h = el.offsetHeight;
      const given = box ? box.offsetHeight : h;
      const fits = Math.abs(given - (el.offsetTop + h)) <= 1 || el.nextElementSibling !== null;
      still = h === last && fits && isDone() ? still + 1 : 0;
      last = h;
      if (still >= 6 || performance.now() - start > 3000) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * After Shift+Enter: puts the cell that was run (the cell showing `el`)
 * `ratio` of the window from the top. The space above it keeps showing the end
 * of the cell before it, so the notebook reads on from one cell to the next.
 *
 * With `fit`, the view moves only when the next cell starts in the bottom
 * `ratio` of the window (or below it), and then only far enough to bring it
 * above that line. It never scrolls up, and the cell that was run keeps its
 * top on screen.
 */
export async function placeAfterRun(el: HTMLElement, nextEl: HTMLElement | undefined, ratio: number, fit = false) {
  const cell = el.closest('.cell_container') as HTMLElement | null;
  const box = el.closest('.output_container') as HTMLElement | null;
  if (!cell || !box) return;
  if (!fit) {
    const v = await viewport();
    await scrollViewTo(cell.getBoundingClientRect().top - Math.round(v.height * ratio));
    return;
  }
  const r = box.getBoundingClientRect();
  const outEnd = r.top + box.offsetHeight;
  let nextTop = outEnd + gap;
  const nextCell = nextEl?.closest('.cell_container') as HTMLElement | null;
  if (nextCell) {
    // The next cell shows a result too, so its top is known exactly.
    nextTop = nextCell.getBoundingClientRect().top;
    if (nextTop > outEnd && nextTop - outEnd < 80) gap = nextTop - outEnd;
  }
  const v = await viewport();
  const line = v.top + v.height - Math.round(v.height * ratio);
  if (nextTop <= line) return;
  const target = Math.min(v.top + (nextTop - line), cell.getBoundingClientRect().top);
  if (target > v.top) await scrollViewTo(target);
}

/** The cell that was run was just put at the top of the window: lower it to `ratio`. */
export async function lowerTop(ratio: number) {
  const v = await viewport();
  await scrollViewTo(v.top - Math.round(v.height * ratio));
}
