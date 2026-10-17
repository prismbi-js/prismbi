// Animated transitions between data states: data points keep their identity (`data-key`) across renders, so their
// geometry can tween from where they were to where they are now.

const ATTRS = ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'x1', 'x2', 'y1', 'y2', 'd', 'points'] as const;
const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

export type MarkSnapshot = Map<string, { tag: string; attrs: Record<string, string> }>;

/** Geometry of every keyed data point under `root`. */
export function snapshotMarks(root: Element): MarkSnapshot {
  const out: MarkSnapshot = new Map();
  for (const el of root.querySelectorAll('[data-key]')) {
    const attrs: Record<string, string> = {};
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null) attrs[a] = v;
    }
    out.set(el.getAttribute('data-key')!, { tag: el.tagName, attrs });
  }
  return out;
}

const skeleton = (s: string) => s.replace(NUM, '#');
const numbers = (s: string) => (s.match(NUM) ?? []).map(Number);

/** An interpolator between two attribute values, or null when they can't be blended (different shapes). */
function blend(from: string, to: string): ((t: number) => string) | null {
  if (from === to) return null;
  const a = numbers(from);
  const b = numbers(to);
  if (!a.length || a.length !== b.length || skeleton(from) !== skeleton(to)) return null;
  const parts = to.split(NUM);
  return (t) => parts.reduce((acc, p, i) => acc + p + (i < b.length ? +(a[i] + (b[i] - a[i]) * t).toFixed(2) : ''), '');
}

const ease = (t: number) => 1 - Math.pow(1 - t, 3);
const frame: (cb: (now: number) => void) => unknown = typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(() => cb(performance.now()), 16);

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Tween data points under `root` from their previous geometry. Points that are new fade in. Returns a function that
 * stops the animation and jumps to the final state, or undefined when there was nothing to animate.
 */
export function tweenMarks(root: Element, prev: MarkSnapshot, duration: number): (() => void) | undefined {
  const tweens: { el: Element; attr: string; to: string; f: (t: number) => string }[] = [];
  const fresh: Element[] = [];
  for (const el of root.querySelectorAll('[data-key]')) {
    const before = prev.get(el.getAttribute('data-key')!);
    if (!before || before.tag !== el.tagName) {
      fresh.push(el);
      continue;
    }
    for (const a of ATTRS) {
      const to = el.getAttribute(a);
      const from = before.attrs[a];
      if (to === null || from === undefined) continue;
      const f = blend(from, to);
      if (f) tweens.push({ el, attr: a, to, f });
    }
  }
  if (!tweens.length && !fresh.length) return undefined;
  for (const tw of tweens) tw.el.setAttribute(tw.attr, tw.f(0));
  for (const el of fresh) (el as SVGElement).style.opacity = '0';
  const start = performance.now();
  let stopped = false;
  const finish = () => {
    stopped = true;
    for (const tw of tweens) tw.el.setAttribute(tw.attr, tw.to);
    for (const el of fresh) (el as SVGElement).style.opacity = '';
  };
  const step = (now: number) => {
    if (stopped) return;
    const t = Math.min(1, (now - start) / Math.max(1, duration));
    if (t >= 1) return finish();
    const e = ease(t);
    for (const tw of tweens) tw.el.setAttribute(tw.attr, tw.f(e));
    for (const el of fresh) (el as SVGElement).style.opacity = String(e);
    frame(step);
  };
  frame(step);
  return finish;
}
