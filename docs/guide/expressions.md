# Expressions (DAX subset)

PrismBI measures and calculated columns use a DAX-compatible syntax and semantics. If you know DAX, you already know this. This page lists what is supported today. The rest is scheduled in the [roadmap](../ROADMAP.md#phase-3-advanced-modeling-and-dax-coverage).

## Syntax

| Element | Example |
|---|---|
| Column | `Sales[Amount]`, `'Sales Data'[Net Amount]` |
| Measure | `[Total Sales]` |
| Table | `Sales`, `'Sales Data'` |
| Numbers, text, booleans | `1.5`, `"text"` (`""` escapes a quote), `TRUE`, `FALSE` |
| Arithmetic | `+ - * / ^`, unary `-` |
| Text concatenation | `&` |
| Comparison | `= == <> < > <= >=` (`==` is strict: BLANK ≠ 0) |
| Logic | `&& \|\| NOT`, `IN { "a", "b" }` |
| Variables | `VAR x = [Sales] VAR y = [Cost] RETURN x - y` |
| Comments | `-- line`, `// line`, `/* block */` |

## Semantics

- **BLANK:** `BLANK() + 1 = 1`, `BLANK() * 5 = BLANK`, and `BLANK() = 0` and `BLANK() = ""` are TRUE. `DIVIDE` returns BLANK, or its third argument, when dividing by zero.
- **Filter context:** aggregations see the rows visible under the current filters, which come from slicers, visual grouping, page and report filters, and `CALCULATE`.
- **Row context:** iterators (`SUMX`, `FILTER`, …) and calculated columns evaluate per row. Inside them, `Table[Column]` reads the current row. A bare table reference or `VALUES()` inside a row context still sees the whole filter context (no transition), so `FILTER(Sales, Sales[Amount] > EARLIER(Sales[Amount]))` in a calculated column scans every row.
- **Context transition:** a measure reference or `CALCULATE` inside a row context turns the current row into filters. For example, `MAXX(Products, [Total Sales])` gives the best-selling product's sales.
- **CALCULATE filter arguments:**
  - `Table[Col] = value` or any boolean expression over **one column** replaces the existing filters on that column.
  - A table expression (`FILTER(...)`, `VALUES(...)`, `DATESYTD(...)`) filters by its rows or values.
  - `ALL(Table)` / `REMOVEFILTERS(Table)` removes the filters on a table (and the tables it reaches). `ALL(Table[Col], …)` removes them for those columns only.
  - `ALLEXCEPT(Table, Table[Col]…)` removes all except the listed columns.
  - `ALLSELECTED(...)` removes only the filters introduced by the visual's own grouping, which gives "share of what's selected".
  - `KEEPFILTERS(expr)` intersects with existing filters instead of replacing them.
  - `USERELATIONSHIP(a, b)` activates an inactive relationship. `CROSSFILTER(a, b, BOTH | ONEWAY | NONE)` changes a relationship's direction for that evaluation.

## Function reference

### Aggregation
`SUM` · `AVERAGE` · `MIN` · `MAX` (one column, or two scalars) · `MEDIAN` · `COUNT` · `COUNTA` · `COUNTBLANK` · `COUNTROWS` · `DISTINCTCOUNT` · `DISTINCTCOUNTNOBLANK` · `PRODUCT`

### Iterators
`SUMX` · `AVERAGEX` · `MINX` · `MAXX` · `MEDIANX` · `PRODUCTX` · `COUNTX` · `COUNTAX` · `CONCATENATEX(table, expr, [delimiter], [orderBy], [ASC|DESC])` · `RANKX(table, expr, [value], [ASC|DESC], [SKIP|DENSE])`

### Filter and context
`CALCULATE` · `CALCULATETABLE` · `FILTER` · `ALL` · `REMOVEFILTERS` · `ALLEXCEPT` · `ALLSELECTED` · `KEEPFILTERS` · `VALUES` · `DISTINCT` · `TOPN(n, table, orderBy, [ASC|DESC])` · `SELECTEDVALUE(col, [alternate])` · `HASONEVALUE` · `ISFILTERED` · `RELATED` · `RELATEDTABLE`

### Time intelligence
These need a date table related to your facts. See [data-model.md](data-model.md#date-tables).

`TOTALYTD(expr, dates, [filter], [yearEnd "mm-dd"])` · `TOTALQTD` · `TOTALMTD` · `DATESYTD(dates, [yearEnd])` · `DATESQTD` · `DATESMTD` · `SAMEPERIODLASTYEAR` · `DATEADD(dates, n, DAY|MONTH|QUARTER|YEAR)` · `PARALLELPERIOD` · `PREVIOUSMONTH` · `PREVIOUSQUARTER` · `PREVIOUSYEAR` · `DATESBETWEEN(dates, start, end)` · `DATESINPERIOD(dates, start, n, DAY|MONTH|QUARTER|YEAR)` · `FIRSTDATE` · `LASTDATE`

Used inside `CALCULATE`, these clear the other filters on the date table (Power BI "mark as date table" behaviour). So `CALCULATE([Sales], SAMEPERIODLASTYEAR(Date[Date]))` works inside a visual grouped by `Date[Year]`.

### Relationships & lookups
`USERELATIONSHIP` · `CROSSFILTER` · `TREATAS(table, col…)` · `LOOKUPVALUE(result, searchCol, value, …, [alternate])` · `CONTAINS(table, col, value, …)` · `CONTAINSROW(table, value…)`

### Table functions
`SUMMARIZE(table, groupBy…, "Name", expr…)` · `SUMMARIZECOLUMNS(groupBy…, [filterTable…], "Name", expr…)` · `ADDCOLUMNS` · `SELECTCOLUMNS` · `CROSSJOIN` · `UNION` · `INTERSECT` · `EXCEPT` · `GENERATE` · `NATURALINNERJOIN` · `NATURALLEFTOUTERJOIN` · `SAMPLE(n, table, orderBy, [ASC|DESC]…)` · `ROW` · `DATATABLE("Col", TYPE, …, {{…}, {…}})` · table constructors `{ 1, 2 }` (column `Value`) and `{ (1, "a"), (2, "b") }` (`Value1`, `Value2`) · `GENERATESERIES` · `CALENDAR` · `CALENDARAUTO([fiscalYearEndMonth])` · `FIRSTNONBLANK` · `LASTNONBLANK` · `ALLNOBLANKROW`

### Financial
`XNPV(table, values, dates, rate)` · `XIRR(table, values, dates, [guess])`

### Statistical
`STDEV.S` · `STDEV.P` · `VAR.S` · `VAR.P` · `STDEVX.S` · `STDEVX.P` · `VARX.S` · `VARX.P` · `PERCENTILE.INC` · `PERCENTILE.EXC` · `PERCENTILEX.INC` · `PERCENTILEX.EXC` · `GEOMEAN` · `GEOMEANX` · `AVERAGEA` · `MAXA` · `MINA`

### Row context, parent-child & scope
`EARLIER(col, [n])` · `EARLIEST` · `PATH(id, parent)` · `PATHLENGTH` · `PATHITEM` · `PATHITEMREVERSE` · `PATHCONTAINS` · `NAMEOF(col or [measure])` · `ISINSCOPE(col)` · `ISCROSSFILTERED`

### Calculation groups & security
`SELECTEDMEASURE` · `SELECTEDMEASURENAME` · `ISSELECTEDMEASURE` · `USERNAME` · `USERPRINCIPALNAME` · `CUSTOMDATA`. See [advanced modeling](advanced-modeling.md).

### Logical
`IF` · `IFERROR` · `SWITCH` (including `SWITCH(TRUE(), …)`) · `AND` · `OR` · `NOT` · `TRUE` · `FALSE` · `BLANK` · `ISBLANK` · `ISNUMBER` · `ISTEXT` · `ISEMPTY` · `COALESCE`

### Math
`DIVIDE` · `ABS` · `ROUND` · `ROUNDUP` · `ROUNDDOWN` · `TRUNC` · `INT` · `CEILING` · `FLOOR` · `SQRT` · `POWER` · `MOD` · `EXP` · `LN` · `LOG` · `LOG10` · `SIGN` · `PI` · `BITAND` · `BITOR` · `BITXOR` · `BITLSHIFT` · `BITRSHIFT`

### Text
`CONCATENATE` · `COMBINEVALUES` · `UPPER` · `LOWER` · `LEN` · `TRIM` · `LEFT` · `RIGHT` · `MID` · `SUBSTITUTE` · `REPT` · `SEARCH` · `FIND` · `CONTAINSSTRING` · `CONTAINSSTRINGEXACT` · `EXACT` · `VALUE` · `FORMAT(value, "format")`

### Date and time
`DATE` · `DATEVALUE` · `TIME` · `TIMEVALUE` · `TODAY` · `NOW` · `UTCNOW` · `UTCTODAY` · `YEAR` · `QUARTER` · `MONTH` · `DAY` · `HOUR` · `MINUTE` · `SECOND` · `WEEKDAY(date, [1|2|3])` · `WEEKNUM` · `EOMONTH` · `EDATE` · `NETWORKDAYS` · `DATEDIFF(start, end, DAY|WEEK|MONTH|QUARTER|YEAR|HOUR|MINUTE|SECOND)` · date arithmetic (`date + 1` adds a day, `date - date` gives days)

## Querying with table expressions

```ts
model.evaluateTable('SUMMARIZECOLUMNS(Products[Category], "Sales", [Total Sales], "Margin", [Margin %])');
```

This works like a DAX query's `EVALUATE` and returns `{ columns, rows }`. Editor tooling (completion, diagnostics, formatting) is covered in [tooling.md](tooling.md).

## Patterns

```dax
-- % of grand total
DIVIDE([Total Sales], CALCULATE([Total Sales], ALL(Products)))

-- % of what's selected (respects slicers, ignores the visual's own grouping)
DIVIDE([Total Sales], CALCULATE([Total Sales], ALLSELECTED(Products)))

-- Year over year
VAR ly = CALCULATE([Total Sales], SAMEPERIODLASTYEAR(Date[Date]))
RETURN IF(ISBLANK(ly), BLANK(), DIVIDE([Total Sales] - ly, ly))

-- Running total within the year
TOTALYTD([Total Sales], Date[Date])

-- Rank of the current product
RANKX(ALL(Products[Name]), [Total Sales])

-- Sales of big orders only
CALCULATE([Total Sales], Sales[Amount] >= 1000)

-- Dynamic title text
"Sales for " & SELECTEDVALUE(Region[Name], "all regions")
```

## Errors

Errors carry readable messages, and a failing visual shows the message in place:

- `DaxSyntaxError`: includes the position and a snippet, e.g. `Expected rparen at position 17: SUM(Sales[Amount]⟦⟧`
- `A single value for column 'Sales'[Amount] cannot be determined…`: a bare column used outside row context
- `Circular dependency detected: A → B → A`
- `Function X is not supported (yet)`

## Window functions

`OFFSET`, `INDEX`, `WINDOW`, `RANK` and `ROWNUMBER` work over an ordered relation, by default the ALLSELECTED values of the `ORDERBY` and `PARTITIONBY` columns:

```dax
Prev Year Sales = CALCULATE([Total Sales], OFFSET(-1, ALLSELECTED(Date[Year]), ORDERBY(Date[Year])))
Running Total   = CALCULATE([Total Sales], WINDOW(1, ABS, 0, REL, ALLSELECTED(Date[MonthNumber]), ORDERBY(Date[MonthNumber])))
Moving Avg 3    = AVERAGEX(WINDOW(-2, REL, 0, REL, ALLSELECTED(Date[MonthNumber]), ORDERBY(Date[MonthNumber])), [Total Sales])
Category Rank   = RANK(DENSE, ALLSELECTED(Product[Category]), ORDERBY([Total Sales], DESC))
Row In Year     = ROWNUMBER(ALLSELECTED(Date[Year], Date[MonthNumber]), ORDERBY(Date[MonthNumber]), PARTITIONBY(Date[Year]))
```

- **`ORDERBY`** takes columns or expressions (measures are evaluated per row), each optionally followed by `ASC` or `DESC`.
- **Ties:** `RANK` uses competition ranking by default (`SKIP`: 1, 2, 2, 4), or `DENSE` (1, 2, 2, 3).
- **Current row:** taken from the row context, or from the single value of each relation column in the filter context.
- **No current row:** when a partition column has no single value, `OFFSET`, `INDEX` and `WINDOW` return an empty table and `RANK` / `ROWNUMBER` return BLANK.

## Visual calculations

A visual calculation is computed over a visual's own rows: after sorting and Top N, in display order. It is often simpler than a measure:

```ts
fields: {
  category: 'Date[MonthYear]',
  values: [
    'Total Sales',
    { name: 'Running total', visualCalc: 'RUNNINGSUM([Total Sales])' },
    { name: 'vs previous', visualCalc: '[Total Sales] - PREVIOUS([Total Sales])', format: '$#,0' },
    { name: 'Share', visualCalc: 'PERCENTOFTOTAL([Total Sales])', format: '0.0%' },
  ],
}
```

| Function | Result |
|---|---|
| `RUNNINGSUM(x)` | running total |
| `MOVINGAVERAGE(x, n)` | average of the last `n` rows |
| `PREVIOUS(x [, k])`, `NEXT(x [, k])` | value `k` rows back or ahead |
| `FIRST(x)`, `LAST(x)` | first or last value |
| `RANK(x [, "ASC"])`, `ROWNUMBER()` | rank (descending by default), position |
| `PERCENTOFTOTAL(x)` | share of the column total |

- **References:** `[Name]` refers to another value of the same visual.
- **Scalar functions:** arithmetic and comparisons, `DIVIDE`, `ABS`, `ROUND`, `IF`, `BLANK`, `ISBLANK`, and two-argument `MIN` / `MAX`.
- **Restarting per group:** with two or more group columns, `reset: 'parent'` restarts window functions for each outer group. Year-to-date by month is `{ visualCalc: 'RUNNINGSUM([Sales])', reset: 'parent' }` grouped by year then month.

## Try it

```js playground
return {
  total: model.evaluate('[Total Sales]'),
  bikes2025: model.evaluate('CALCULATE([Total Sales], Product[Category] = "Bikes", Date[Year] = 2025)'),
  bestMonth: model.evaluate('MAXX(VALUES(Date[MonthYear]), [Total Sales])'),
  categories: model.evaluateTable('ADDCOLUMNS(VALUES(Product[Category]), "Sales", [Total Sales])').rows,
};
```

On the docs site (`npm run docs`), **▶ Run in playground** opens it in an editor next to its output.
