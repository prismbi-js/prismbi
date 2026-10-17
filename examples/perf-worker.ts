/// <reference lib="webworker" />
import { serveModel } from '@prismbi/prismbi/worker';
import { buildModel } from './perf-data';

// build the model once the page says how many rows, then answer engine calls
const init = (e: MessageEvent) => {
  if (e.data?.type !== 'init') return;
  self.removeEventListener('message', init);
  serveModel(buildModel(e.data.rows));
  self.postMessage({ type: 'ready' });
};
self.addEventListener('message', init);
