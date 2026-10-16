# React

```tsx
import { PrismReport, PrismVisual, usePrismReport } from 'prismbi/react';
```

React 17+ is an optional peer dependency. The bindings are about 1 KB, and the core does the work.

## `<PrismReport>`

```tsx
const definition = useMemo(() => ({ pages: [...] }), []); // stable identity!

export function Dashboard() {
  const ref = usePrismReport();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  return (
    <>
      <button onClick={() => ref.current?.goToPage('Details')}>Details</button>
      <PrismReport
        ref={ref}
        model={model}
        definition={definition}
        theme={theme}
        chrome={{ filterPane: true }}
        filters={[{ target: 'Date[Year]', op: 'eq', value: 2025 }]}  // controlled report filters
        onSelectionChanged={(e) => console.log(e.filters)}
        onDataPointClick={(e) => navigate(`/category/${e.keys[0]}`)}
        style={{ height: 720 }}
      />
    </>
  );
}
```

| Prop | Behaviour |
|---|---|
| `model`, `definition`, `locale`, `chrome` | A change of identity rebuilds the report, so memoise them |
| `theme` | Applied incrementally (no rebuild) |
| `page` | Controlled page (id or name) |
| `filters` | Controlled report-level filters |
| `onSelectionChanged`, `onFiltersChanged`, `onPageChanged`, `onDataPointClick`, `onDrill`, `onError`, `onRendered` | Event callbacks. Always the latest closure, with no resubscribe |
| `ref` | The imperative [`Report`](interactions.md#programmatic-control) instance |

## `<PrismVisual>`

A single visual you can place anywhere, without the toolbar, tabs or pane:

```tsx
<PrismVisual
  model={model}
  type="clusteredBar"
  title="Top products"
  fields={{ category: 'Products[Name]', values: 'Total Sales' }}
  top={10}
  format={{ dataLabels: { show: true } }}
  filters={[{ target: 'Region[Name]', op: 'eq', value: region }]}
  style={{ height: 360 }}
/>
```

Spec props (`type`, `fields`, `filters`, `format`, `sort`, `top`, `interaction`) update in place.

## SSR / Next.js

Reports need the DOM, so render them on the client: `'use client'` in Next.js, or `dynamic(() => import(...), { ssr: false })`. The model and DAX engine run anywhere, so you can call `model.query()` in server components or API routes.
