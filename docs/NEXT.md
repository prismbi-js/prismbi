# Where work stopped (handoff)

Last updated 2026-10-17. Branch `phase-5`; local `master` fast-forwarded to the same commit. **Nothing is pushed**: pushing needs the owner's explicit go-ahead. There is deliberately no CI workflow.

## State

- **Phases 1–5 are done.** Phase 6 is half done: 3 of 6 items.
- **Tests:** 253 pass (`npm test`).
- **Checks:** `npm run typecheck` and `npm run build` are clean. `npm run bench` gives the 200k / 1M-row timings.
- **Entries:** `@prismbi/prismbi`, `/core`, `/visuals`, `/studio`, `/react`, `/connectors`, `/worker`, `/files`, `/elements`, `/ai`.
- **CLI:** `bin/prismbi.mjs`.
- **Demo pages** (`npm run dev`, then http://localhost:5173): `/`, `/studio.html`, `/perf.html`, `/elements.html`.

## Remaining Phase 6 items (do in this order)

### 1. ✅ DONE: `@prismbi/prismbi/server` (src/server.ts, tests/server.test.ts, docs/guide/server.md)

Kept below for reference.

#### Original plan

Create `src/server.ts` as a new entry. Register it in all of these:
- `tsup.config.ts`
- `package.json` exports (and `sideEffects` only if it registers anything)
- the alias lists in `vitest.config.ts` and `examples/vite.config.ts`

Contents:
- **`withDom(window, fn)`:** installs and later restores the globals. Covers `window`, `document`, `HTMLElement`, `SVGElement`, `Element`, `Node`, `getComputedStyle`, `Event`, `CustomEvent`, `MouseEvent` and `KeyboardEvent`. The caller passes any DOM (jsdom, linkedom, happy-dom), so the library takes on no dependency.
- **Headless sizes:** a layout-less DOM reports `clientWidth` 0, so `VisualHost.render` (`src/report/visualHost.ts`, `this.size = …`) needs explicit pixel sizes.
  - Add a `ReportOptions.measure?: (visualId) => { width, height } | undefined` option, threaded through `ReportRuntime`.
  - Compute boxes from the grid layout: columns, rowHeight and gap, minus about 24 px padding and 20 px title.
- **`renderVisualSvg(model, spec, { window, width, height, theme })`:** returns the visual's own `<svg>` for charts. HTML visuals (cards, tables) fall back to `elementToSvg` in `src/report/snapshot.ts`.
- **`renderReportHtml(model, def, { window, page, width, theme })`:** returns a standalone HTML string. It includes `prismCss` and the theme's CSS variables on the root, with visuals absolutely positioned.
- **`watchMeasure(model, { measure, filters, when: { above } | { below } | { changeBy: pct } | fn, onAlert, debounceMs })`:**
  - Edge-triggered.
  - Re-evaluates on `model.onChange`, so it works with `streamInto` and `scheduleRefresh`.
  - Returns a stop function.
- **`scheduleReport({ every: ms | 'daily@HH:MM', run, onError })`:** a simple scheduler. Email delivery is the user's job; document a nodemailer example.
- **Tests:** run with `// @vitest-environment node` plus `new JSDOM()`. `measureText` already falls back to an estimate under jsdom.
- **Docs:** `docs/guide/server.md`.

### 2. NEXT: Collaboration: `@prismbi/prismbi/collab`

- **Document:** an operation-based document over report JSON. Visuals and pages are keyed by id, and properties use last-writer-wins with Lamport clocks and a site id.
  - Hook into the Studio history snapshots (`src/studio/history.ts`) and `Report.load` / `definitionChanged`.
- **Transport interface:** `send(op)` / `onMessage`. Built in: `BroadcastChannel`, which lets two tabs co-edit with no server, plus a WebSocket relay example.
- **Comments on data points:** `{ id, visualId, identity, text, author, at, resolved }`, stored in the document and shown as badges, plus a comments pane in the Studio.
- **Shared bookmarks:** stored in the document.
- **Demo:** open `/studio.html` in two tabs. Test with two in-memory peers.

### 3. Plugins: `@prismbi/prismbi/plugins`

- **Manifest:** `{ name, version, kind: 'visual' | 'connector' | 'theme', entry, integrity: 'sha256-…', signature }`.
- **`loadPlugin(url, { trustedKeys })`:**
  - Fetch the code.
  - Verify its SHA-256 and an ECDSA P-256 / Ed25519 signature with WebCrypto.
  - `import()` it from a blob URL and register it.
  - Reject unsigned plugins unless `allowUnsigned`.
- **Signing:** `scripts/sign-plugin.mjs` (Node crypto) to generate keys and sign.
- **Marketplace:** a JSON index format, plus a "Get more visuals" gallery in the Studio's visualizations pane.

### Then

- **Docs:** update `docs/ROADMAP.md` (Phase 6 checklist), `CHANGELOG.md` 0.6.0, the README docs list and sizes, and the CONTRIBUTING budgets.
- **Sizes today, min+gzip:** core ≈60 KB (budget 62), full ≈93 KB (95), studio ≈96 KB (100), ai ≈15.5 KB, elements ≈1.7 KB, files ≈2.7 KB, connectors ≈3 KB, worker ≈1.3 KB. Measure by bundling a `dist` import with esbuild, `--minify`, then gzip.
- **Review:** run a live headless-Chrome check of the new pages. There's a CDP driver pattern in the session scratchpad (`cdp.mjs`): launch Chrome with `--headless=new --remote-debugging-port`, then use the global `WebSocket`.
- **Wrap-up:** commit on `phase-5` (or a new `phase-6` branch), then `git checkout master && git merge --ff-only`. Do not push.

## Gotchas learned

- **Escaping:** inline `node - <<'EOF'` scripts with template literals mangle regex backslashes (`\[`, `\/`, `\\`). Use the Edit tool for lines containing regexes, or write a script file.
- **Stray `cat`:** never leave a bare `cat > file` without a heredoc; it blocks on stdin.
- **Line endings:** LF is enforced (`.gitattributes`). Normalise `\r\n` in scripts.
- **Attribution:** author is Santhoshkumar Hariharan.
- **Previews:** show them as local HTML pages, not published artifacts.
