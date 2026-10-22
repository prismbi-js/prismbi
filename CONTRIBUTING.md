# Contributing to PrismBI

## Setup

```bash
npm install
npm run dev         # demo at http://localhost:5173 – edits to src/ hot-reload
npm test            # vitest + jsdom
npm run typecheck
npm run build
```

## Where things live

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layer diagram and source map. In short: `src/data` (storage, model, query), `src/dax` (formula engine), `src/visuals` (built-in visuals), `src/report` (runtime, chrome, edit mode), `src/studio` (report editor), `src/react` (bindings).

## Ground rules

- **No runtime dependencies, and size budgets.** `npm run build && npm run size` bundles each entry from `dist` the way an app would (minified, code splitting on, package imports resolved to `dist`) and fails when what loads up front, gzipped, is over its budget in `scripts/size.mjs`. As of 0.9 that is about 80 KB for an app using `DataModel` + `Report` from `/core`, 122 KB with every visual (`@prismbi/prismbi`), 122 KB for the Studio, 3 KB for `/connectors`, 2.1 KB for `/worker`, and 25 KB for `/ai` and 11 KB for `/sql` on top of the full entry. Raise a budget only deliberately, in the commit that needs it. Connectors and the worker entry must only import types from the core. Editor tooling (`dax/language.ts`, `dax/functions.ts`) must stay tree-shakeable, so the model must not import it. Mark new visual definitions `/* @__PURE__ */` so they tree-shake. Load rarely used, action-triggered code (exports, PDF) with `import()`.
- **Semantics match Power BI.** When adding DAX or filter behaviour, add a test that reproduces Power BI's result on a small model (see `tests/fixtures.ts`). Document any deliberate difference in `docs/guide/expressions.md`.
- **Visuals follow the shared mark specs.** Bars are at most 24 px thick with 4 px rounded data ends, there are 2 px surface gaps between touching marks, lines are 2 px, markers are at least 8 px, and the grid is recessive. Text uses theme ink tokens, never series colours. There's a legend whenever there are two or more series, and colour always follows the entity.
- **Accessibility:** marks are focusable, labels are not clipped, and every chart has a table view.
- **Public APIs** need TSDoc comments, an export in `src/index.ts`, and an entry in the relevant guide.

## Adding things

| To add | Do |
|---|---|
| A DAX function | Add a `case` in `src/dax/evaluator.ts` `call()`. If it evaluates arguments in its own context, add it to `CONTEXT_FUNCS`. Add tests in `tests/dax.test.ts` and a line in `docs/guide/expressions.md` |
| A visual | Create `src/visuals/<name>.ts` with `defineVisual`, register it in `src/visuals/index.ts`, add it to the "renders every built-in visual" test, and document its roles and format options in `docs/guide/visuals.md` |
| A filter operator | Extend `FilterOp` and `compileFilter` in `src/data/filters.ts`, then add it to `ADV_OPS` in `src/report/filterPane.ts` |

## Commits and releases

- Use Conventional Commits (`feat:`, `fix:`, `perf:`, `docs:`) and record user-visible changes in `CHANGELOG.md`.
- `npm publish` runs `prepublishOnly`, which typechecks, tests and builds.

## Visual regression tests

`npm run test:visual` renders every visual in `/gallery.html` (light and dark), screenshots each one with headless Chrome, and compares it with the baselines in `tests/visual/`.
- **Failure:** a visual fails when more than 0.5% of its pixels differ noticeably. The new screenshot is saved to `tests/visual/__diff__/`.
- **Intended changes:** after checking the new screenshots, run `npm run test:visual -- --update` and commit the updated baselines.
- **Chrome:** found automatically, or set `CHROME_PATH`.
- **Platform:** baselines depend on installed fonts, so keep one set per platform or CI image.
- **New visuals:** add them to `GALLERY` in `examples/gallery-main.ts`.
