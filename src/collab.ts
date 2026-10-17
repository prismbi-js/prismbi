/**
 * PrismBI collaboration: live co-editing of a report, presence, comments on visuals and data points, and shared
 * bookmarks. State is a last-writer-wins map of report entries, so every peer converges whatever order messages
 * arrive in. Bring a transport: BroadcastChannel (tabs, no server), a WebSocket relay, or your own.
 *
 * ```ts
 * import { connectReport, broadcastChannelTransport } from '@prismbi/prismbi/collab';
 * const session = connectReport(report, broadcastChannelTransport('sales-report'), { user: 'Ana' });
 * ```
 */
import { registerMenuItems } from '@prismbi/prismbi';
import type { Bookmark, CellValue, DataPointIdentity, PageDefinition, Report, ReportDefinition, VisualSpec } from '@prismbi/prismbi';

// ---------------------------------------------------------------- document

/** Lamport clock value plus site id: a total order for last-writer-wins. */
export interface Stamp {
  t: number;
  site: string;
}

const newer = (a: Stamp, b: Stamp | undefined) => !b || a.t > b.t || (a.t === b.t && a.site > b.site);

export interface Entry {
  stamp: Stamp;
  /** `null` = deleted (tombstone). */
  value: unknown;
}

export interface Comment {
  id: string;
  visualId: string;
  pageId: string;
  /** The data point, when the comment is on one. */
  point?: { columns: { table: string; column: string }[]; values: CellValue[] };
  text: string;
  author: string;
  at: string;
  resolved?: boolean;
  /** Replies to another comment. */
  parent?: string;
}

const DATE_TAG = '$date';
/** JSON-safe copy with dates tagged (JSON.stringify would turn them into plain strings first). */
const plain = (v: unknown): unknown => {
  if (v instanceof Date) return { [DATE_TAG]: v.toISOString() };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined && typeof x !== 'function') out[k] = plain(x);
    return out;
  }
  return v;
};
const revive = (v: unknown): unknown => JSON.parse(JSON.stringify(v), (_k, x) => (x && typeof x === 'object' && DATE_TAG in x && Object.keys(x).length === 1 ? new Date(x[DATE_TAG]) : x));

/**
 * The shared state: keys like `report`, `page:<id>`, `visual:<page>:<id>`, `bookmark:<name>`, `comment:<id>`.
 * Pages and visuals carry an `order` so concurrent inserts merge deterministically.
 */
export class CollabDoc {
  readonly site: string;
  private clock = 0;
  private entries = new Map<string, Entry>();

  constructor(site = Math.random().toString(36).slice(2, 10)) {
    this.site = site;
  }

  get(key: string): unknown {
    return this.entries.get(key)?.value ?? null;
  }

  /** Local write: returns the entry to broadcast. */
  set(key: string, value: unknown): [string, Entry] {
    const entry: Entry = { stamp: { t: ++this.clock, site: this.site }, value: value === null ? null : plain(value) };
    this.entries.set(key, entry);
    return [key, entry];
  }

  /** Merge remote entries; returns the keys that changed. */
  merge(remote: [string, Entry][]): string[] {
    const changed: string[] = [];
    for (const [key, e] of remote) {
      this.clock = Math.max(this.clock, e.stamp.t);
      if (newer(e.stamp, this.entries.get(key)?.stamp)) {
        this.entries.set(key, e);
        changed.push(key);
      }
    }
    return changed;
  }

  snapshot(): [string, Entry][] {
    return [...this.entries];
  }

  keys(prefix: string): string[] {
    return [...this.entries.keys()].filter((k) => k.startsWith(prefix) && this.entries.get(k)!.value !== null);
  }

  // ------------------------------------------------------------ report <-> entries

  /** Entries describing a report definition. */
  static entriesOf(def: ReportDefinition): Map<string, unknown> {
    const out = new Map<string, unknown>();
    const { pages, bookmarks, ...top } = def;
    out.set('report', top);
    pages.forEach((p, pi) => {
      const pid = p.id ?? `page-${pi}`;
      const { visuals, ...rest } = p;
      out.set(`page:${pid}`, { ...rest, id: pid, order: pi });
      visuals.forEach((v, vi) => out.set(`visual:${pid}:${v.id ?? `v${vi}`}`, { ...v, id: v.id ?? `v${vi}`, order: vi }));
    });
    for (const b of bookmarks ?? []) out.set(`bookmark:${b.name}`, b);
    return out;
  }

  /** Rebuild a report definition from the current entries. */
  toDefinition(): ReportDefinition {
    const byOrder = (a: { order?: number; id?: string }, b: { order?: number; id?: string }) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id));
    const pages = this.keys('page:')
      .map((k) => revive(this.get(k)) as PageDefinition & { order?: number })
      .sort(byOrder)
      .map(({ order: _o, ...p }) => ({
        ...p,
        visuals: this.keys(`visual:${p.id}:`)
          .map((k) => revive(this.get(k)) as VisualSpec & { order?: number })
          .sort(byOrder)
          .map(({ order: _vo, ...v }) => v as VisualSpec),
      }));
    const bookmarks = this.keys('bookmark:').map((k) => revive(this.get(k)) as Bookmark);
    return { ...((revive(this.get('report')) as object) ?? {}), pages: pages as PageDefinition[], ...(bookmarks.length ? { bookmarks } : {}) } as ReportDefinition;
  }

  /** Local writes for whatever differs between the entries and `def`. */
  diff(def: ReportDefinition): [string, Entry][] {
    const next = CollabDoc.entriesOf(def);
    const out: [string, Entry][] = [];
    for (const [k, v] of next) if (JSON.stringify(plain(v)) !== JSON.stringify(this.get(k))) out.push(this.set(k, v));
    for (const k of [...this.keys('report'), ...this.keys('page:'), ...this.keys('visual:'), ...this.keys('bookmark:')]) if (!next.has(k)) out.push(this.set(k, null));
    return out;
  }
}

// ---------------------------------------------------------------- transports

export type CollabMessage =
  | { type: 'hello'; site: string; user: Presence }
  | { type: 'state'; site: string; to?: string; entries: [string, Entry][] }
  | { type: 'ops'; site: string; entries: [string, Entry][] }
  | { type: 'presence'; site: string; user: Presence }
  | { type: 'bye'; site: string };

export interface Transport {
  send(message: CollabMessage): void;
  /** Returns an unsubscribe function. */
  subscribe(fn: (message: CollabMessage) => void): () => void;
  close?(): void;
}

/** Peers in the same browser (tabs, windows, iframes) on one channel name. No server needed. */
export function broadcastChannelTransport(name: string): Transport {
  const ch = new BroadcastChannel(`prismbi:${name}`);
  return {
    send: (m) => ch.postMessage(m),
    subscribe(fn) {
      const h = (e: MessageEvent) => fn(e.data as CollabMessage);
      ch.addEventListener('message', h);
      return () => ch.removeEventListener('message', h);
    },
    close: () => ch.close(),
  };
}

/** A JSON relay over WebSocket: the server broadcasts each message to the other clients in the room. */
export function webSocketTransport(url: string): Transport {
  const ws = new WebSocket(url);
  const queue: string[] = [];
  ws.addEventListener('open', () => queue.splice(0).forEach((m) => ws.send(m)));
  return {
    send(m) {
      const s = JSON.stringify(m);
      if (ws.readyState === WebSocket.OPEN) ws.send(s);
      else queue.push(s);
    },
    subscribe(fn) {
      const h = (e: MessageEvent) => fn(JSON.parse(String(e.data)));
      ws.addEventListener('message', h);
      return () => ws.removeEventListener('message', h);
    },
    close: () => ws.close(),
  };
}

/** In-memory hub (tests, demos): each `connect()` is a peer; messages reach every other peer asynchronously. */
export function memoryHub() {
  const peers = new Set<(m: CollabMessage) => void>();
  return {
    connect(): Transport {
      let mine: ((m: CollabMessage) => void) | null = null;
      return {
        send: (m) => {
          const copy = JSON.parse(JSON.stringify(m));
          queueMicrotask(() => peers.forEach((p) => p !== mine && p(copy)));
        },
        subscribe(fn) {
          mine = fn;
          peers.add(fn);
          return () => peers.delete(fn);
        },
      };
    },
  };
}

// ---------------------------------------------------------------- session

export interface Presence {
  site: string;
  name: string;
  color: string;
  /** Visual this user has selected (edit mode). */
  visualId?: string | null;
  pageId?: string;
}

export interface CollabOptions {
  /** Display name for presence and comments. */
  user?: string;
  color?: string;
  /** Show other users' selections and comment badges on the report (default true). */
  ui?: boolean;
  /** How long a newcomer waits for the room's state before seeding it with its own report (default 400 ms). */
  joinTimeoutMs?: number;
}

export interface CollabSession {
  readonly doc: CollabDoc;
  /** Other users currently connected. */
  peers(): Presence[];
  comments(filter?: { visualId?: string; includeResolved?: boolean }): Comment[];
  addComment(c: { visualId: string; text: string; point?: DataPointIdentity; parent?: string }): Comment;
  resolveComment(id: string, resolved?: boolean): void;
  deleteComment(id: string): void;
  on(event: 'change' | 'comments' | 'peers', fn: () => void): () => void;
  disconnect(): void;
}

/** Escape a value for a double-quoted attribute selector. */
const attr = (v: string) => v.replace(/["\\]/g, (c) => `\\${c}`);

const COLORS = ['#2a78d6', '#e8743b', '#19a979', '#945ecf', '#ed4a7b', '#13a4b4', '#c79b00'];

/** Join a collaborative session for a report (works for a Studio's `studio.report` too). */
export function connectReport(report: Report, transport: Transport, opts: CollabOptions = {}): CollabSession {
  const doc = new CollabDoc();
  const me: Presence = { site: doc.site, name: opts.user ?? 'Guest', color: opts.color ?? COLORS[Math.floor(Math.random() * COLORS.length)], pageId: report.currentPage.id };
  const peers = new Map<string, Presence>();
  const listeners = { change: new Set<() => void>(), comments: new Set<() => void>(), peers: new Set<() => void>() };
  const emit = (e: keyof typeof listeners) => listeners[e].forEach((f) => f());
  let applying = false;
  // joining: adopt the room's state when someone answers; the first person in the room seeds it instead
  let joined = false;
  const seed = () => {
    if (joined) return;
    joined = true;
    const ops = doc.diff(report.toJSON());
    if (ops.length) transport.send({ type: 'ops', site: doc.site, entries: ops });
  };
  const joinTimer = setTimeout(seed, opts.joinTimeoutMs ?? 400);

  const applyRemote = (changed: string[]) => {
    if (!changed.length) return;
    if (changed.some((k) => !k.startsWith('comment:'))) {
      applying = true;
      try {
        report.load(doc.toDefinition());
      } finally {
        applying = false;
      }
      emit('change');
    }
    if (changed.some((k) => k.startsWith('comment:'))) emit('comments');
    renderUi();
  };

  const offTransport = transport.subscribe((m) => {
    if (m.site === doc.site) return;
    switch (m.type) {
      case 'hello':
        peers.set(m.site, m.user);
        transport.send({ type: 'state', site: doc.site, to: m.site, entries: doc.snapshot() });
        sendPresence();
        emit('peers');
        break;
      case 'state':
        if (m.to && m.to !== doc.site) break;
        if (!joined && m.entries.length) {
          joined = true;
          clearTimeout(joinTimer);
        }
        applyRemote(doc.merge(m.entries));
        break;
      case 'ops':
        applyRemote(doc.merge(m.entries));
        break;
      case 'presence':
        peers.set(m.site, m.user);
        emit('peers');
        renderUi();
        break;
      case 'bye':
        peers.delete(m.site);
        emit('peers');
        renderUi();
        break;
    }
  });

  const offDef = report.on('definitionChanged', () => {
    if (applying || !joined) return;
    const ops = doc.diff(report.toJSON());
    if (ops.length) {
      transport.send({ type: 'ops', site: doc.site, entries: ops });
      emit('change');
    }
  });
  // the page id is read at send time: adopting the room's report replaces pages without a pageChanged event
  const sendPresence = () => transport.send({ type: 'presence', site: doc.site, user: { ...me, pageId: report.currentPage.id } });
  const offSel = report.on('visualSelected', (e) => {
    me.visualId = e.visualId;
    sendPresence();
  });
  // visuals re-render (and reloads recreate them): redraw overlays afterwards, once per frame
  let uiQueued = false;
  const offRendered = report.on('rendered', () => {
    if (uiQueued) return;
    uiQueued = true;
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => setTimeout(f, 0))(() => {
      uiQueued = false;
      renderUi();
    });
  });
  const offPage = report.on('pageChanged', (e) => {
    me.pageId = e.pageId;
    sendPresence();
    renderUi();
  });

  const comments = (f: { visualId?: string; includeResolved?: boolean } = {}) =>
    doc
      .keys('comment:')
      .map((k) => doc.get(k) as Comment)
      .filter((c) => (!f.visualId || c.visualId === f.visualId) && (f.includeResolved || !c.resolved))
      .sort((a, b) => a.at.localeCompare(b.at));
  const writeComment = (c: Comment | null, id: string) => {
    transport.send({ type: 'ops', site: doc.site, entries: [doc.set(`comment:${id}`, c)] });
    emit('comments');
    renderUi();
  };

  // ------------------------------------------------------------ UI: presence outlines and comment badges
  const ui = opts.ui !== false && typeof document !== 'undefined';
  const renderUi = () => {
    if (!ui) return;
    const root = report.root;
    root.querySelectorAll('.pbi-presence, .pbi-comment-badge').forEach((e) => e.remove());
    for (const p of peers.values()) {
      if (!p.visualId || p.pageId !== report.currentPage.id) continue;
      const v = root.querySelector<HTMLElement>(`[data-visual-id="${attr(p.visualId)}"]`);
      if (!v) continue;
      const tag = document.createElement('div');
      tag.className = 'pbi-presence';
      tag.style.cssText = `position:absolute;inset:-3px;border:2px solid ${p.color};border-radius:calc(var(--pbi-radius) + 3px);pointer-events:none;z-index:5`;
      const label = document.createElement('span');
      label.textContent = p.name;
      label.style.cssText = `position:absolute;top:-10px;right:8px;background:${p.color};color:#fff;font-size:10px;line-height:1.6;padding:0 6px;border-radius:4px`;
      tag.append(label);
      v.append(tag);
    }
    const counts = new Map<string, number>();
    for (const c of comments()) if (c.pageId === report.currentPage.id) counts.set(c.visualId, (counts.get(c.visualId) ?? 0) + 1);
    for (const [vid, n] of counts) {
      const v = root.querySelector<HTMLElement>(`[data-visual-id="${attr(vid)}"]`);
      if (!v) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pbi-comment-badge';
      b.title = `${n} comment${n === 1 ? '' : 's'}`;
      b.setAttribute('aria-label', b.title);
      b.textContent = `💬 ${n}`;
      b.style.cssText = 'position:absolute;left:8px;bottom:6px;z-index:6;font:11px var(--pbi-font);padding:1px 6px;border-radius:999px;border:1px solid var(--pbi-border);background:var(--pbi-surface);color:var(--pbi-fg-2);cursor:pointer';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        openThread(vid, b);
      });
      v.append(b);
    }
  };

  const openThread = (visualId: string, anchor: HTMLElement) => {
    document.querySelector('.pbi-comment-thread')?.remove();
    const panel = document.createElement('div');
    panel.className = 'pbi-comment-thread';
    panel.style.cssText = 'position:fixed;z-index:1100;width:300px;max-height:360px;overflow:auto;padding:10px;background:var(--pbi-surface);color:var(--pbi-fg);border:1px solid var(--pbi-border);border-radius:10px;box-shadow:0 12px 40px rgb(0 0 0/.2);font:12px/1.5 var(--pbi-font)';
    const r = anchor.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 310))}px`;
    panel.style.top = `${Math.max(8, Math.min(r.bottom + 6, innerHeight - 370))}px`;
    const list = document.createElement('div');
    for (const c of comments({ visualId })) {
      const item = document.createElement('div');
      item.style.cssText = 'padding:6px 0;border-bottom:1px solid var(--pbi-grid)';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;gap:8px;color:var(--pbi-fg-3)';
      head.textContent = `${c.author} · ${new Date(c.at).toLocaleString()}`;
      const done = document.createElement('button');
      done.type = 'button';
      done.textContent = 'Resolve';
      done.style.cssText = 'border:0;background:none;color:var(--pbi-accent);cursor:pointer;font:inherit';
      done.addEventListener('click', () => {
        session.resolveComment(c.id);
        openThread(visualId, anchor);
      });
      head.append(done);
      const body = document.createElement('div');
      body.textContent = (c.point ? `[${c.point.values.map(String).join(' · ')}] ` : '') + c.text;
      item.append(head, body);
      list.append(item);
    }
    const form = document.createElement('form');
    form.style.cssText = 'display:flex;gap:6px;margin-top:8px';
    const input = document.createElement('input');
    input.placeholder = 'Add a comment';
    input.setAttribute('aria-label', 'Comment');
    input.style.cssText = 'flex:1;min-width:0;font:inherit;padding:5px 8px;border:1px solid var(--pbi-border);border-radius:6px;background:var(--pbi-bg);color:var(--pbi-fg)';
    form.append(input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      session.addComment({ visualId, text: input.value.trim() });
      openThread(visualId, anchor);
    });
    panel.append(list, form);
    report.root.append(panel);
    const close = (e: MouseEvent) => {
      if (!panel.contains(e.target as Node)) {
        panel.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close));
    input.focus();
  };

  // "Comment on this point" in data-point menus of this report
  const offMenu = registerMenuItems((c) => {
    if (c.report !== report) return [];
    return [
      {
        label: 'Comment on this point',
        onClick: () => {
          const text = typeof prompt === 'function' ? prompt('Comment') : null;
          if (text?.trim()) session.addComment({ visualId: c.visualId, text: text.trim(), point: c.identity });
        },
      },
    ];
  });

  const session: CollabSession = {
    doc,
    peers: () => [...peers.values()],
    comments,
    addComment(c) {
      const comment: Comment = {
        id: `${doc.site}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        visualId: c.visualId,
        pageId: report.currentPage.id,
        text: c.text,
        author: me.name,
        at: new Date().toISOString(),
        ...(c.point ? { point: { columns: c.point.columns.map((x) => ({ table: x.table, column: x.column })), values: c.point.values } } : {}),
        ...(c.parent ? { parent: c.parent } : {}),
      };
      writeComment(comment, comment.id);
      return comment;
    },
    resolveComment(id, resolved = true) {
      const c = doc.get(`comment:${id}`) as Comment | null;
      if (c) writeComment({ ...c, resolved }, id);
    },
    deleteComment(id) {
      writeComment(null, id);
    },
    on(event, fn) {
      listeners[event].add(fn);
      return () => listeners[event].delete(fn);
    },
    disconnect() {
      transport.send({ type: 'bye', site: doc.site });
      offTransport();
      offDef();
      offSel();
      offPage();
      offRendered();
      offMenu();
      clearTimeout(joinTimer);
      transport.close?.();
      if (ui) report.root.querySelectorAll('.pbi-presence, .pbi-comment-badge, .pbi-comment-thread').forEach((e) => e.remove());
    },
  };

  transport.send({ type: 'hello', site: doc.site, user: me });
  return session;
}
