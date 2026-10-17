import { Studio } from '@prismbi/prismbi/studio';
import { broadcastChannelTransport, connectReport } from '@prismbi/prismbi/collab';
import { buildModel } from './model';

const model = buildModel();
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const params = new URLSearchParams(location.search);
const room = params.get('room');

// Autosaves to this browser; delete the key (or use Import) to start over. Rooms autosave separately.
const studio = new Studio(document.getElementById('studio')!, {
  model,
  storageKey: room ? `prismbi-studio-room-${room}` : 'prismbi-studio-demo',
  theme: dark ? 'dark' : 'light',
});

studio.on('change', (doc) => console.debug('document changed', doc));

// Co-editing: open /studio.html?room=demo in two tabs (BroadcastChannel needs no server)
const session = room ? connectReport(studio.report, broadcastChannelTransport(room), { user: params.get('user') ?? `Guest ${Math.floor(Math.random() * 90 + 10)}` }) : null;
if (session) session.on('peers', () => (document.title = `PrismBI Studio · ${room} · ${session.peers().length + 1} editing`));

Object.assign(window, { studio, model, session });
