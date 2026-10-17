import { DataModel, Report } from 'prismbi';
import { streamInto, type MessageSourceLike, type StreamHandle } from 'prismbi/connectors';
import { createWorkerEngine, type Engine } from 'prismbi/worker';
import { CUSTOMERS, buildModel, makeRows } from './perf-data';

// ---------------------------------------------------------------- report
const statsEl = document.getElementById('stats')!;
const rowsSel = document.getElementById('rows') as HTMLSelectElement;
const liveBtn = document.getElementById('live') as HTMLButtonElement;
const workerBox = document.getElementById('worker') as HTMLInputElement;
let engine: Engine | undefined;

/** Start a worker that builds the same model and serves it. */
function startWorker(rows: number): Promise<Engine> {
  const worker = new Worker(new URL('./perf-worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve) => {
    const ready = (e: MessageEvent) => {
      if (e.data?.type !== 'ready') return;
      worker.removeEventListener('message', ready);
      resolve(createWorkerEngine(worker));
    };
    worker.addEventListener('message', ready);
    worker.postMessage({ type: 'init', rows });
  });
}
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
let report: Report | undefined;
let model: DataModel;
let stream: StreamHandle | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let loadInfo = '';

function timings(m: DataModel): string {
  const t = (name: string, f: () => unknown) => {
    const a = performance.now();
    f();
    return `${name} ${(performance.now() - a).toFixed(0)} ms`;
  };
  return [
    t('by category', () => m.query({ groupBy: ['Product[Category]'], values: ['Sales', 'Orders', 'Avg Order'] })),
    t('product × country', () => m.query({ groupBy: ['Product[Product]', 'Customer[Country]'], values: ['Sales'] })),
    t('per customer (scatter)', () => m.query({ groupBy: ['Customer[Customer]', 'Customer[Segment]'], values: ['Sales', 'Orders'] })),
    t('dense line', () => m.query({ groupBy: ['Sales[Tick]'], values: ['Sales'] })),
  ].join(' · ');
}

function build(): void {
  stopLive();
  const n = Number(rowsSel.value);
  statsEl.textContent = `Generating ${n.toLocaleString('en-US')} rows…`;
  // let the message paint before the heavy work
  engine?.dispose();
  engine = undefined;
  setTimeout(async () => {
    if (workerBox.checked) {
      statsEl.textContent = `Generating ${n.toLocaleString('en-US')} rows in a worker and on the page…`;
      engine = await startWorker(n);
    }
    const t0 = performance.now();
    model = buildModel(n);
    const loadMs = performance.now() - t0;
    loadInfo = `${n.toLocaleString('en-US')} rows · load + model ${loadMs.toFixed(0)} ms · visual queries run ${engine ? 'in a Web Worker' : 'on the main thread'}\nqueries (cold, main thread): ${timings(model)}`;
    const t1 = performance.now();
    report?.destroy();
    report = new Report(document.getElementById('app')!, {
      model,
      engine,
      theme: dark ? 'dark' : 'light',
      name: 'Scale',
      chrome: { filterPane: 'closed' },
      pages: [
        {
          id: 'scale',
          name: 'At scale',
          layout: { columns: 12, rowHeight: 40 },
          visuals: [
            { id: 'cat', type: 'slicer', title: 'Category', layout: { x: 0, y: 0, w: 6, h: 2 }, fields: { field: 'Product[Category]' }, format: { slicer: { style: 'tiles' } } },
            { id: 'country', type: 'slicer', title: 'Country', layout: { x: 6, y: 0, w: 6, h: 2 }, fields: { field: 'Customer[Country]' }, format: { slicer: { style: 'tiles' } } },
            { id: 'k-sales', type: 'card', title: 'Sales', layout: { x: 0, y: 2, w: 3, h: 3 }, fields: { value: 'Sales' } },
            { id: 'k-orders', type: 'card', title: 'Orders', layout: { x: 3, y: 2, w: 3, h: 3 }, fields: { value: 'Orders' } },
            { id: 'k-aov', type: 'card', title: 'Avg order', layout: { x: 6, y: 2, w: 3, h: 3 }, fields: { value: 'Avg Order' } },
            { id: 'k-rows', type: 'card', title: 'Rows in view', layout: { x: 9, y: 2, w: 3, h: 3 }, fields: { value: 'Rows' } },
            {
              id: 'line',
              type: 'line',
              title: 'Sales over time',
              layout: { x: 0, y: 5, w: 12, h: 6 },
              fields: { category: 'Sales[Tick]', values: 'Sales' },
              format: { title: { subtitle: 'Thousands of points, thinned with LTTB for drawing — hover reads every point' } },
            },
            {
              id: 'scatter',
              type: 'scatter',
              title: 'Customers: sales vs orders',
              layout: { x: 0, y: 11, w: 7, h: 9 },
              fields: { details: 'Customer[Customer]', legend: 'Customer[Segment]', x: 'Orders', y: 'Sales' },
              format: { title: { subtitle: `${CUSTOMERS.toLocaleString('en-US')} points on a canvas · click to cross-filter` } },
            },
            { id: 'table', type: 'table', title: 'Customers', layout: { x: 7, y: 11, w: 5, h: 9 }, fields: { columns: ['Customer[Customer]', 'Customer[Country]', 'Sales', 'Orders'] }, format: { title: { subtitle: 'Virtualized rows' } } },
          ],
        },
      ],
    });
    requestAnimationFrame(() => {
      loadInfo += engine ? `\nfirst paint ${(performance.now() - t1).toFixed(0)} ms (results arrive from the worker)` : `\nfirst render ${(performance.now() - t1).toFixed(0)} ms`;
      statsEl.textContent = loadInfo;
    });
  }, 30);
}

// ---------------------------------------------------------------- live stream (simulated socket)
class FakeSocket implements MessageSourceLike {
  private fns = new Set<(e: { data: unknown }) => void>();
  addEventListener(_t: 'message', fn: (e: { data: unknown }) => void) {
    this.fns.add(fn);
  }
  removeEventListener(_t: 'message', fn: (e: { data: unknown }) => void) {
    this.fns.delete(fn);
  }
  emit(data: string) {
    for (const f of this.fns) f({ data });
  }
}

function startLive(): void {
  const socket = new FakeSocket();
  const max = Number(rowsSel.value);
  let received = 0;
  const started = performance.now();
  // the window keeps the table at its current size: oldest rows drop as new ones arrive
  stream = streamInto(model, 'Sales', socket, {
    maxRows: max,
    intervalMs: 500,
    onBatch: (rows) => {
      received += rows.length;
      // keep the worker's copy in step
      void engine?.appendRows('Sales', rows, { maxRows: max });
      const secs = (performance.now() - started) / 1000;
      statsEl.textContent = `${loadInfo}\nlive: ${received.toLocaleString('en-US')} rows received (${Math.round(received / secs).toLocaleString('en-US')}/s) · window ${max.toLocaleString('en-US')} rows`;
    },
  });
  timer = setInterval(() => socket.emit(JSON.stringify(makeRows(400))), 100);
  liveBtn.textContent = 'Stop live stream';
  liveBtn.setAttribute('aria-pressed', 'true');
}

function stopLive(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  stream?.close();
  stream = undefined;
  liveBtn.textContent = 'Start live stream';
  liveBtn.setAttribute('aria-pressed', 'false');
}

liveBtn.addEventListener('click', () => (stream ? stopLive() : startLive()));
document.getElementById('rebuild')!.addEventListener('click', build);
rowsSel.addEventListener('change', build);
workerBox.addEventListener('change', build);
build();
