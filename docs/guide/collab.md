# Collaboration: co-editing, presence and comments

`@prismbi/prismbi/collab` lets several people edit the same report live. It also shows who is looking at what, and supports comments on visuals and data points. Bookmarks are shared too.

```ts
import { connectReport, broadcastChannelTransport } from '@prismbi/prismbi/collab';

const session = connectReport(studio.report, broadcastChannelTransport('sales-q3'), { user: 'Ana' });
```

Try it: run `npm run dev`, then open `/studio.html?room=demo` in two tabs (add `&user=Ana` to name yourself).

## How it stays consistent

- **Entries:** the report is split into entries: report settings, each page, each visual, each bookmark and each comment.
- **Stamps:** every write carries a stamp (a Lamport counter plus a client id), and the newest stamp wins.
- **Convergence:** peers end up identical whatever order messages arrive in.
- **Ordering:** pages and visuals carry an order, so concurrent inserts merge predictably.
- **Joining:** a newcomer announces itself and adopts the room's report when someone answers. If nobody answers within `joinTimeoutMs` (400 ms by default), it is first in the room and seeds the room with its own report.
- **Local edits:** anything that fires `definitionChanged` (Studio edits, `addVisual`, `updateVisual`, filters…) is broadcast as changed entries only.
- **Remote edits:** applied with `report.load`, keeping the current page.

Two people changing the *same* visual at the same moment resolve to one of the changes. Different visuals never conflict.

## Transports

| Transport | Use |
|---|---|
| `broadcastChannelTransport(room)` | Tabs and windows of the same browser; no server |
| `webSocketTransport(url)` | A JSON relay server that forwards each message to the other clients in the room |
| `memoryHub().connect()` | Tests and in-page demos |
| Your own `{ send, subscribe, close? }` | WebRTC, Ably, Pusher, Liveblocks, Supabase Realtime… |

A minimal WebSocket relay just rebroadcasts. With `ws` on Node:

```ts
wss.on('connection', (socket) => socket.on('message', (m) => wss.clients.forEach((c) => c !== socket && c.send(String(m)))));
```

## Presence

- **Selections:** other users' selected visuals (in edit mode) get an outline in their colour with their name.
- **Peers:** `session.peers()` lists who is connected, and `session.on('peers', …)` fires when that changes.

## Comments

```ts
session.addComment({ visualId: 'cols', text: 'Why is Bikes so high?' });
session.addComment({ visualId: 'cols', text: 'Check Q4', point: identity }); // on a data point
session.comments({ visualId: 'cols' });
session.resolveComment(id);
session.on('comments', render);
```

- **Badges:** visuals with open comments show a 💬 badge. Clicking it opens the thread, where you can reply or resolve.
- **Right-click:** data points get **Comment on this point**.
- **Storage:** comments live in the shared document like everything else, so they sync and persist with it.

## Options

```ts
connectReport(report, transport, { user: 'Ana', color: '#2a78d6', ui: true, joinTimeoutMs: 400 });
```

- **`ui: false`:** turns off the built-in outlines and badges, so you can draw your own from `peers()` and `comments()`.
- **`session.disconnect()`:** leaves the room and removes the overlays.
