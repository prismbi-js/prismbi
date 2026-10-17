# Report files and version control

A report is one JSON document. That's convenient to load, but every change touches the same big file. `@prismbi/prismbi/files` stores it as a folder of small, stable files instead, so reviews show exactly what changed and branches merge cleanly.

```
report.json                          name, version, report filters, page and bookmark order
pages/overview/page.json             page settings and visual order
pages/overview/visuals/cols.json     one file per visual
pages/overview/visuals/year.json
bookmarks/bikes-only.json            one file per bookmark
```

## API

```ts
import { splitReport, joinReport, diffReports, formatDiff, stableStringify } from '@prismbi/prismbi/files';

const files = splitReport(report.toJSON());   // { 'report.json': '…', 'pages/overview/page.json': '…', … }
const def = joinReport(files);                // back to a ReportDefinition (migrated to the current schema)
console.log(formatDiff(diffReports(before, after)));
```

- **Stable output.**
  - Keys come in a fixed order: `id`, `name`, `type`, `title`, `layout`, `fields`, … then alphabetical.
  - Small flat objects such as `layout` stay on one line.
  - Id lists go one per line.
  - Dates are tagged `{"$date": "…"}`.
  - Splitting the same report twice gives identical files.
- **Ids.** Folder and file names come from page and visual ids. Pages and visuals without an id get one, derived from their name, or from their type and position. Renaming a visual's title never moves its file.
- **Merge-tolerant joins.** A visual file that isn't in its page's order list is appended, which happens when two branches each add a visual. A listed id whose file was deleted is skipped. Broken JSON reports the file it came from.
- **Plain-language diffs.**
  - **What it compares:** two definitions or JSON strings.
  - **What it reports:** pages, visuals and bookmarks added, removed or reordered, plus every changed property with its path.
  - **Output:** `formatDiff` prints one line per change: `+` added, `-` removed, `~` changed, `↕` reordered.

```
- page "Overview" › visual "year"
~ page "Overview" › visual "Sales by category" › format.dataLabels.show: true → false
+ page "Details" › visual "kpi"
↕ page order: ["overview","details"] → ["details","overview"]
```

## Command line

The package installs a `@prismbi/prismbi` command:

```bash
npx @prismbi/prismbi split report.json reports/sales      # write the folder
npx @prismbi/prismbi join reports/sales report.json       # rebuild one file (stdout without a file name)
npx @prismbi/prismbi diff old.json reports/sales          # either side may be a JSON file or a split folder
```

`diff` exits with code 1 when there are changes and 0 when there are none, so it fits in CI checks and pre-commit hooks.
