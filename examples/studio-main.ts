import { Studio } from 'prismbi/studio';
import { buildModel } from './model';

const model = buildModel();
const dark = matchMedia('(prefers-color-scheme: dark)').matches;

// Autosaves to this browser; delete the key (or use Import) to start over.
const studio = new Studio(document.getElementById('studio')!, {
  model,
  storageKey: 'prismbi-studio-demo',
  theme: dark ? 'dark' : 'light',
});

studio.on('change', (doc) => console.debug('document changed', doc));
Object.assign(window, { studio, model });
