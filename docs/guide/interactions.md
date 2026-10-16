# Slicing, filtering and interactions

PrismBI gives you every Power BI way of narrowing data down, and each one is scriptable.

| Mechanism | Scope | Set by |
|---|---|---|
| Report filters | all pages | filter pane, `report.setReportFilters()`, `definition.filters` |
| Page filters | one page | filter pane, `report.setPageFilters()`, `page.filters` |
| Visual filters | one visual | filter pane (click the visual first), `report.setVisualFilters()`, `visual.filters` |
| Slicers | other visuals on the page | user, `report.setSlicerSelection()` |
| Cross-filter / cross-highlight | other visuals on the page | clicking data points, legend entries or table rows |
| Drill | one visual | double-click a data point, or the header ↑ / ⇊ |

All of them compose with AND.

## Slicers

```ts
{ id: 'region', type: 'slicer', title: 'Region', fields: { field: 'Region[Name]' },
  format: { slicer: { style: 'tiles', single: false } } }
```

| Style | Best for | Behaviour |
|---|---|---|
| `list` | text, few to hundreds of values | checkboxes, Select all, search once there are more than 7 values |
| `dropdown` | saving space | the same list in a popover |
| `tiles` | a handful of values | buttons. Click selects one value, Ctrl/⌘+click adds more (`single: false` makes every click add) |
| `between` | numbers and dates (default for dates) | from/to inputs plus a dual-thumb slider |
| `relative` | dates | Last, Next or This N days, weeks, months or years |

A slicer filters every other visual on its page, but not itself. Its own list of values is narrowed by the other filters and slicers, so you get cascading slicers for free.

```ts
report.setSlicerSelection('region', [{ target: 'Region[Name]', op: 'in', values: ['North'] }]);
report.setSlicerSelection('region', null); // clear
```

## Cross-filtering and cross-highlighting

Clicking a data point selects it. **Ctrl** or **⌘** + click adds to the selection, clicking the same point again clears it, and clicking empty space or pressing **Esc** clears everything. Every other visual on the page reacts:

- **highlight** is the default for column, bar, pie, donut, treemap and funnel. They keep their full values faded and draw the selected portion solid.
- **filter** is the default for everything else. They re-query with the selection as a filter.
- **none** means the visual ignores selections.

```ts
{ type: 'line', interaction: 'filter', ... }                       // how this visual reacts
{ type: 'card', interactionsFrom: { 'by-category': 'none' }, ... } // per source visual
```

The source visual dims unselected marks. Clicking a legend entry selects the whole series. A table or matrix row selects its group values.

## Drill down

Put several fields in a drillable role to create a hierarchy:

```ts
fields: { category: ['Date[Year]', 'Date[Quarter]', 'Date[Month]'], values: 'Total Sales' }
```

- Double-clicking a data point drills into that member. For example, 2025 shows that year's quarters.
- **↑** drills up a level.
- **⇊ Go to next level** shows all members of the next level, without a parent filter.
- A breadcrumb under the title shows the path, e.g. `Year: 2025 › Quarter: Q2`.

```ts
report.visual('trend').drillDown(2025);
report.visual('trend').drillUp();
report.on('drill', (e) => console.log(e.level, e.path));
```

## The filter pane

Turn it on with `chrome: { filterPane: true }` (a toolbar toggle) or `'open'`. It lists filter cards for **this visual** (the last one clicked), **this page** and **all pages**. Each card has three modes:

- **Basic:** tick values from the column's full domain, with search.
- **Advanced:** contains, does not contain, starts with, ends with, is, is not, >, ≥, <, ≤, is blank, is not blank.
- **Top N:** top or bottom N items, ranked by any measure.

Use **+ Add data field** to add a card for any visible column. An empty card means "is (All)" and filters nothing.

## Filter reference

```ts
type FilterSpec =
  | { target: 'Table[Col]', op: 'in' | 'notIn', values: CellValue[] }
  | { target, op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte', value }
  | { target, op: 'between', min?, max? }                       // inclusive, open-ended allowed
  | { target, op: 'contains' | 'notContains' | 'startsWith' | 'endsWith', value } // case-insensitive
  | { target, op: 'isBlank' | 'isNotBlank' }
  | { targets: ['T[a]', 'T[b]'], op: 'tuples', tuples: [[a1, b1], [a2, b2]] }  // multi-column selections
  | { target, op: 'topN', n: 5, by: 'Total Sales', direction?: 'top' | 'bottom' };
```

Filters on a dimension column flow to related fact tables. Filters on a fact column don't flow back to dimensions (single-direction relationships).

## Bookmarks

A bookmark captures the current page, report and page filters, every slicer, the selection and drill states.

```ts
const bm = report.captureBookmark('West, last 6 months');
report.applyBookmark(bm);                 // or by name
report.bookmarkList();
report.on('bookmarkApplied', (e) => ...);
```

Bookmarks are included in `report.toJSON()`.

## Programmatic control

```ts
report.goToPage('Details');
report.setReportFilters([{ target: 'Date[Year]', op: 'eq', value: 2025 }]);
report.setPageFilters('overview', [{ target: 'Products[Category]', op: 'notIn', values: ['Accessories'] }]);
report.setVisualFilters('top-products', [{ target: 'Products[Name]', op: 'topN', n: 10, by: 'Total Sales' }]);
report.getFilters();          // { report, page, slicers }
report.clearSelection();
report.reset();               // clear slicers, selection and drill on the current page
```

## Events

| Event | Payload |
|---|---|
| `selectionChanged` | `{ pageId, visualId, identities, filters }` |
| `filtersChanged` | `{ pageId, scope: 'report'\|'page'\|'visual'\|'slicer', visualId?, filters }` |
| `dataPointClick` | `{ visualId, keys, identity, event }` |
| `drill` | `{ visualId, level, path }` |
| `pageChanged` | `{ pageId, name }` |
| `rendered` | `{ visualId, ms }` |
| `error` | `{ visualId, error }` |
| `themeChanged`, `bookmarkApplied` | `{ name }` |

```ts
const off = report.on('dataPointClick', ({ keys }) => router.push(`/category/${keys[0]}`));
off();
```
