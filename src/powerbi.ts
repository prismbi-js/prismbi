/**
 * Power BI import: read a `.pbip` project (TMDL or model.bim semantic model, PBIR or legacy report.json report) into
 * a PrismBI model and report. Projects carry no rows, so pass data per table (from `@prismbi/prismbi/connectors`);
 * tables without data are created empty with their columns.
 *
 * ```ts
 * import { importPowerBI } from '@prismbi/prismbi/powerbi';
 * const { model, report, warnings } = importPowerBI(files, { data: { Sales: await loadCsv('/sales.csv') } });
 * ```
 */
import { DataModel, DataTable, parseDax } from '@prismbi/prismbi';
import type { ColumnSchema, DataType, FieldSpec, PageDefinition, ReportDefinition, Row, VisualSpec } from '@prismbi/prismbi';

/** Project files keyed by forward-slash path (relative to the .pbip folder). */
export type PbipFiles = Record<string, string>;

export interface PbiColumn {
  name: string;
  dataType?: string;
  formatString?: string;
  isHidden?: boolean;
  displayFolder?: string;
  description?: string;
  /** DAX of a calculated column. */
  expression?: string;
  sortByColumn?: string;
  /** Where an import or calculated table column comes from (`[Value1]` for a table constructor's first column). */
  sourceColumn?: string;
  /** A date column's auto date/time table: `defaultHierarchy` is `Table.'Hierarchy'`. */
  variation?: { defaultHierarchy?: string; relationship?: string };
  /** Aggregation mapping (Power BI "manage aggregations"): the detail column or table this column summarizes. */
  alternateOf?: { baseColumn?: string; baseTable?: string; summarization?: string };
}

export interface PbiMeasure {
  name: string;
  expression: string;
  formatString?: string;
  displayFolder?: string;
  description?: string;
  isHidden?: boolean;
}

export interface PbiCalculationItem {
  name: string;
  expression: string;
  ordinal?: number;
  /** DAX returning the item's format string, e.g. `"0.0%"`. */
  formatStringDefinition?: string;
}

export interface PbiTable {
  name: string;
  columns: PbiColumn[];
  measures: PbiMeasure[];
  isHidden?: boolean;
  /** Calculation group (Time Intelligence, …): the table's items rewrite whatever measure is shown. */
  calculationGroup?: { precedence?: number; items: PbiCalculationItem[] };
  /** DAX of a calculated table (partition source of type calculated). */
  calculated?: string;
}

export interface PbiRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  isActive?: boolean;
  crossFilteringBehavior?: string;
}

export interface PbiModel {
  tables: PbiTable[];
  relationships: PbiRelationship[];
}

// ---------------------------------------------------------------- TMDL

const unquote = (s: string) => {
  const t = s.trim();
  return t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : t;
};

/** Split `Table.'Column Name'` / `'My Table'.Col` into parts. */
function splitRef(ref: string): [string, string] {
  const m = /^('(?:[^']|'')+'|[^.]+)\.(.+)$/.exec(ref.trim());
  return m ? [unquote(m[1]), unquote(m[2])] : [ref.trim(), ''];
}

const indentOf = (line: string) => {
  const m = /^[\t ]*/.exec(line)![0];
  return m.replace(/ {4}/g, '\t').replace(/ /g, '').length;
};

/** model.bim's `alternateOf` ({ baseColumn: { table, column } | "T.C", baseTable, summarization }) in TMDL's shape. */
function bimAlternateOf(a: unknown): PbiColumn['alternateOf'] {
  if (!a || typeof a !== 'object') return undefined;
  const o = a as Record<string, unknown>;
  const col = o.baseColumn as { table?: string; column?: string; name?: string } | string | undefined;
  const tab = o.baseTable as { table?: string; name?: string } | string | undefined;
  return {
    baseColumn: typeof col === 'string' ? col : col ? `${col.table}.${col.column ?? col.name}` : undefined,
    baseTable: typeof tab === 'string' ? tab : (tab?.table ?? tab?.name),
    summarization: o.summarization as string | undefined,
  };
}

/** Parse the TMDL files of a semantic model (`definition/tables/*.tmdl`, `definition/relationships.tmdl`, …). */
export function parseTmdl(texts: string[]): PbiModel {
  const tables: PbiTable[] = [];
  const relationships: PbiRelationship[] = [];
  for (const text of texts) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let table: PbiTable | null = null;
    let obj: { kind: string; target: Record<string, unknown>; indent: number; exprKey?: string } | null = null;
    let rel: (Partial<PbiRelationship> & { indent: number }) | null = null;
    let fence = false;
    let fenceTarget: { target: Record<string, unknown>; key: string } | null = null;
    // an "alternateOf" block inside a column
    let alt: { target: Record<string, unknown>; indent: number } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      // ``` fenced multi-line expressions
      if (fence) {
        if (line.startsWith('```')) {
          fence = false;
          fenceTarget = null;
        } else if (fenceTarget) fenceTarget.target[fenceTarget.key] = `${fenceTarget.target[fenceTarget.key] ? `${fenceTarget.target[fenceTarget.key]}\n` : ''}${raw.trim()}`;
        continue;
      }
      if (!line || line.startsWith('///') || line.startsWith('//')) continue;
      const ind = indentOf(raw);
      if (alt && ind <= alt.indent) alt = null;
      if (alt) {
        const p = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
        if (p) alt.target[p[1]] = unquote(p[2].trim());
        continue;
      }
      // expression continuation: deeper than the object's properties
      if (obj?.exprKey && ind >= obj.indent + 2) {
        obj.target[obj.exprKey] = `${obj.target[obj.exprKey] ? `${obj.target[obj.exprKey]}\n` : ''}${line}`;
        continue;
      }
      // a declaration ("column Year"), not a property that shares the keyword ("column: Year" in a hierarchy level)
      const head = /^(table|column|measure|relationship|partition|hierarchy|level|annotation|calculationGroup|calculationItem|expression|role|culture|perspective|model|database|ref|dataSource)(?!\s*:)\s*(.*)$/.exec(line);
      if (head && (ind === 0 || ['column', 'measure', 'partition', 'hierarchy', 'calculationGroup', 'calculationItem', 'annotation', 'level'].includes(head[1]))) {
        const [, kind, rest] = head;
        const eq = rest.match(/^((?:'(?:[^']|'')*'|[^=])*?)\s*=\s*(.*)$/);
        const name = unquote(eq ? eq[1] : rest);
        const expr = eq ? eq[2].trim() : undefined;
        obj = null;
        if (kind === 'table') {
          table = { name, columns: [], measures: [] };
          tables.push(table);
          rel = null;
          continue;
        }
        if (kind === 'relationship') {
          rel = { indent: ind };
          continue;
        }
        if (!table) continue;
        if (kind === 'column') {
          const col: PbiColumn = { name };
          table.columns.push(col);
          obj = { kind, target: col as unknown as Record<string, unknown>, indent: ind };
          if (expr !== undefined) {
            if (expr.startsWith('```')) {
              fence = true;
              fenceTarget = { target: col as unknown as Record<string, unknown>, key: 'expression' };
            } else {
              col.expression = expr;
              obj.exprKey = 'expression';
            }
          }
          continue;
        }
        if (kind === 'measure') {
          const m: PbiMeasure = { name, expression: '' };
          table.measures.push(m);
          obj = { kind, target: m as unknown as Record<string, unknown>, indent: ind, exprKey: 'expression' };
          if (expr?.startsWith('```')) {
            fence = true;
            fenceTarget = { target: m as unknown as Record<string, unknown>, key: 'expression' };
            obj.exprKey = undefined;
          } else m.expression = expr ?? '';
          continue;
        }
        if (kind === 'calculationGroup') {
          table.calculationGroup = { items: [] };
          obj = { kind, target: table.calculationGroup as unknown as Record<string, unknown>, indent: ind };
          continue;
        }
        if (kind === 'calculationItem' && table.calculationGroup) {
          const it: PbiCalculationItem = { name, expression: expr ?? '' };
          table.calculationGroup.items.push(it);
          obj = { kind, target: it as unknown as Record<string, unknown>, indent: ind, exprKey: 'expression' };
          if (expr?.startsWith('```')) {
            it.expression = '';
            fence = true;
            fenceTarget = { target: it as unknown as Record<string, unknown>, key: 'expression' };
            obj.exprKey = undefined;
          }
          continue;
        }
        if (kind === 'partition') {
          // "partition X = calculated" with a DAX source makes a calculated table
          const p: Record<string, unknown> = { partitionType: expr };
          obj = { kind, target: p, indent: ind };
          (table as PbiTable & { _partition?: Record<string, unknown> })._partition = p;
          continue;
        }
        obj = { kind, target: {}, indent: ind };
        continue;
      }
      // properties
      const prop = /^([A-Za-z]+)\s*[:=]\s*(.*)$/.exec(line);
      if (rel && ind > rel.indent && prop) {
        const [, k, v] = prop;
        if (k === 'fromColumn') [rel.fromTable, rel.fromColumn] = splitRef(v);
        if (k === 'toColumn') [rel.toTable, rel.toColumn] = splitRef(v);
        if (k === 'isActive') rel.isActive = v.trim() !== 'false';
        if (k === 'crossFilteringBehavior') rel.crossFilteringBehavior = v.trim();
        if (rel.fromColumn && rel.toColumn && !relationships.includes(rel as PbiRelationship)) relationships.push(rel as PbiRelationship);
        continue;
      }
      if (obj && prop && ind === obj.indent + 1) {
        const [, k, v] = prop;
        obj.exprKey = obj.kind === 'partition' && k === 'source' ? 'source' : undefined;
        const value = v.trim();
        if (obj.kind === 'partition' && k === 'source') {
          if (value.startsWith('```')) {
            fence = true;
            fenceTarget = { target: obj.target, key: 'source' };
          } else obj.target.source = value;
          continue;
        }
        if (value === '' && k === 'expression') {
          obj.exprKey = 'expression';
          continue;
        }
        // format string definitions are DAX (a quoted literal stays quoted)
        if (k === 'formatStringDefinition') {
          if (value.startsWith('```')) {
            fence = true;
            fenceTarget = { target: obj.target, key: k };
          } else if (value) obj.target[k] = value;
          else obj.exprKey = k;
          continue;
        }
        obj.target[k] = value === 'true' ? true : value === 'false' ? false : /^-?\d+(\.\d+)?$/.test(value) && (k === 'precedence' || k === 'ordinal') ? Number(value) : unquote(value);
        continue;
      }
      if (table && prop && ind === 1 && (prop[1] === 'isHidden')) table.isHidden = prop[2].trim() !== 'false';
      // nested blocks of a column: "alternateOf" (aggregations) and "variation <name>" (its auto date/time table)
      if (obj?.kind === 'column' && (line === 'alternateOf' || /^variation\b/.test(line)) && ind === obj.indent + 1) {
        const a: Record<string, unknown> = {};
        obj.target[line === 'alternateOf' ? 'alternateOf' : 'variation'] = a;
        alt = { target: a, indent: ind };
        continue;
      }
      // a bare flag line like "isHidden"
      if (obj && /^[A-Za-z]+$/.test(line) && ind === obj.indent + 1) obj.target[line] = true;
    }
    for (const t of tables) {
      const p = (t as PbiTable & { _partition?: Record<string, unknown> })._partition;
      if (p && p.partitionType === 'calculated' && typeof p.source === 'string') t.calculated = p.source;
      delete (t as PbiTable & { _partition?: unknown })._partition;
    }
  }
  for (const t of tables) {
    for (const m of t.measures) m.expression = m.expression.trim();
    for (const it of t.calculationGroup?.items ?? []) {
      it.expression = it.expression.trim();
      if (it.formatStringDefinition) it.formatStringDefinition = it.formatStringDefinition.trim();
    }
  }
  return { tables, relationships };
}

/** Parse a TMSL `model.bim` (the JSON semantic model of older projects). */
export function parseModelBim(json: string | Record<string, unknown>): PbiModel {
  const bim = (typeof json === 'string' ? JSON.parse(json) : json) as { model?: { tables?: unknown[]; relationships?: unknown[] } };
  const joinExpr = (e: unknown) => (Array.isArray(e) ? e.join('\n') : typeof e === 'string' ? e : '');
  const tables: PbiTable[] = (bim.model?.tables ?? []).map((t) => {
    const tt = t as Record<string, unknown>;
    const parts = (tt.partitions as { source?: { type?: string; expression?: unknown } }[] | undefined) ?? [];
    const calc = parts.find((p) => p.source?.type === 'calculated');
    return {
      name: String(tt.name),
      isHidden: !!tt.isHidden,
      columns: ((tt.columns as Record<string, unknown>[]) ?? []).filter((c) => c.type !== 'rowNumber').map((c) => ({ name: String(c.name), dataType: c.dataType as string, formatString: c.formatString as string, isHidden: !!c.isHidden, displayFolder: c.displayFolder as string, description: joinExpr(c.description) || undefined, expression: c.type === 'calculated' ? joinExpr(c.expression) : undefined, sortByColumn: c.sortByColumn as string, sourceColumn: c.sourceColumn as string | undefined, alternateOf: bimAlternateOf(c.alternateOf) })),
      measures: ((tt.measures as Record<string, unknown>[]) ?? []).map((m) => ({ name: String(m.name), expression: joinExpr(m.expression), formatString: m.formatString as string, displayFolder: m.displayFolder as string, description: joinExpr(m.description) || undefined, isHidden: !!m.isHidden })),
      calculated: calc ? joinExpr(calc.source?.expression) : undefined,
      ...(tt.calculationGroup
        ? (() => {
            const cg = tt.calculationGroup as { precedence?: number; calculationItems?: { name: string; expression: unknown; ordinal?: number; formatStringDefinition?: { expression?: unknown } }[] };
            return { calculationGroup: { precedence: cg.precedence, items: (cg.calculationItems ?? []).map((i) => ({ name: String(i.name), expression: joinExpr(i.expression), ordinal: i.ordinal, formatStringDefinition: i.formatStringDefinition ? joinExpr(i.formatStringDefinition.expression) : undefined })) } };
          })()
        : {}),
    };
  });
  const relationships = (bim.model?.relationships ?? []).map((r) => {
    const rr = r as Record<string, unknown>;
    return { fromTable: String(rr.fromTable), fromColumn: String(rr.fromColumn), toTable: String(rr.toTable), toColumn: String(rr.toColumn), isActive: rr.isActive !== false, crossFilteringBehavior: rr.crossFilteringBehavior as string };
  });
  return { tables, relationships };
}

// ---------------------------------------------------------------- report mapping

/** Power BI visual type → PrismBI type and role names (Power BI role → PrismBI role). */
const VISUALS: Record<string, { type: string; roles: Record<string, string> }> = {
  clusteredColumnChart: { type: 'clusteredColumn', roles: { Category: 'category', Y: 'values', Series: 'legend' } },
  columnChart: { type: 'stackedColumn', roles: { Category: 'category', Y: 'values', Series: 'legend' } },
  hundredPercentStackedColumnChart: { type: 'percentStackedColumn', roles: { Category: 'category', Y: 'values', Series: 'legend' } },
  clusteredBarChart: { type: 'clusteredBar', roles: { Category: 'category', Y: 'values', Series: 'legend' } },
  barChart: { type: 'stackedBar', roles: { Category: 'category', Y: 'values', Series: 'legend' } },
  hundredPercentStackedBarChart: { type: 'percentStackedBar', roles: { Category: 'category', Y: 'values', Series: 'legend' } },
  lineChart: { type: 'line', roles: { Category: 'category', Y: 'values', Series: 'legend' } },
  areaChart: { type: 'area', roles: { Category: 'category', Y: 'values', Series: 'legend' } },
  stackedAreaChart: { type: 'stackedArea', roles: { Category: 'category', Y: 'values', Series: 'legend' } },
  lineClusteredColumnComboChart: { type: 'lineClusteredColumn', roles: { Category: 'category', Y: 'values', Y2: 'lineValues' } },
  lineStackedColumnComboChart: { type: 'lineClusteredColumn', roles: { Category: 'category', Y: 'values', Y2: 'lineValues' } },
  ribbonChart: { type: 'ribbon', roles: { Category: 'category', Y: 'values', Series: 'legend' } },
  waterfallChart: { type: 'waterfall', roles: { Category: 'category', Y: 'values' } },
  pieChart: { type: 'pie', roles: { Category: 'legend', Y: 'values' } },
  donutChart: { type: 'donut', roles: { Category: 'legend', Y: 'values' } },
  treemap: { type: 'treemap', roles: { Group: 'category', Values: 'values' } },
  funnel: { type: 'funnel', roles: { Category: 'category', Y: 'values' } },
  scatterChart: { type: 'scatter', roles: { Category: 'details', Details: 'details', X: 'x', Y: 'y', Size: 'size', Series: 'legend' } },
  card: { type: 'card', roles: { Values: 'value' } },
  cardVisual: { type: 'card', roles: { Data: 'value', Values: 'value' } },
  multiRowCard: { type: 'multiRowCard', roles: { Values: 'values' } },
  kpi: { type: 'kpi', roles: { Indicator: 'value', TrendLine: 'trend', Goal: 'target' } },
  gauge: { type: 'gauge', roles: { Y: 'value', TargetValue: 'target' } },
  tableEx: { type: 'table', roles: { Values: 'columns' } },
  pivotTable: { type: 'matrix', roles: { Rows: 'rows', Columns: 'columns', Values: 'values' } },
  slicer: { type: 'slicer', roles: { Values: 'field' } },
  map: { type: 'map', roles: { Category: 'location', Size: 'size', Series: 'legend' } },
  azureMap: { type: 'map', roles: { Category: 'location', Size: 'size', Series: 'legend', Latitude: 'latitude', Longitude: 'longitude' } },
  filledMap: { type: 'filledMap', roles: { Category: 'location', Values: 'values' } },
  decompositionTreeVisual: { type: 'decompositionTree', roles: { Analyze: 'values', ExplainBy: 'explainBy' } },
  textbox: { type: 'text', roles: {} },
};

const AGG: Record<number, string> = { 0: 'sum', 1: 'avg', 2: 'distinctCount', 3: 'min', 4: 'max', 5: 'count', 6: 'median' };
const ref = (table: string, column: string) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) ? table : `'${table.replace(/'/g, "''")}'`}[${column}]`;

/** Separates a date column from the level of its auto date/time hierarchy until the level's table is known. */
const VARIATION = '\u0001';

/** A Power BI query field (Column / Measure / Aggregation / HierarchyLevel) as a PrismBI field spec. */
function fieldOf(field: Record<string, unknown> | undefined, warn: (m: string) => void): FieldSpec | null {
  if (!field) return null;
  const entityOf = (e: unknown) => ((e as { Expression?: { SourceRef?: { Entity?: string; Source?: string } } })?.Expression?.SourceRef?.Entity ?? '') as string;
  if (field.Column) {
    const c = field.Column as { Property: string };
    return ref(entityOf(field.Column), c.Property);
  }
  if (field.Measure) return (field.Measure as { Property: string }).Property;
  if (field.Aggregation) {
    const a = field.Aggregation as { Expression?: { Column?: { Property: string } }; Function?: number };
    const col = a.Expression?.Column;
    if (!col) return null;
    const agg = AGG[a.Function ?? 0];
    if (!agg) warn(`Aggregation function ${a.Function} mapped to sum`);
    return { field: ref(entityOf(a.Expression!.Column), col.Property), aggregation: (agg ?? 'sum') as never };
  }
  if (field.HierarchyLevel) {
    const hl = field.HierarchyLevel as { Expression?: { Hierarchy?: { Expression?: { PropertyVariationSource?: { Expression?: unknown; Property: string } } } }; Level: string };
    // auto date/time: a level of the hidden date table behind a date column, resolved once relationships are known
    const pv = hl.Expression?.Hierarchy?.Expression?.PropertyVariationSource;
    if (pv) return `${ref(entityOf(pv), pv.Property)}${VARIATION}${hl.Level}`;
    return ref(entityOf(hl.Expression?.Hierarchy), hl.Level);
  }
  return null;
}

function gridLayout(pos: { x?: number; y?: number; z?: number; width?: number; height?: number }, pageW: number) {
  const scale = 1280 / (pageW || 1280);
  const col = 1280 / 12;
  const row = 56;
  const x = Math.max(0, Math.min(11, Math.round(((pos.x ?? 0) * scale) / col)));
  const w = Math.max(1, Math.min(12 - x, Math.round(((pos.width ?? 300) * scale) / col)));
  return { x, y: Math.max(0, Math.round(((pos.y ?? 0) * scale) / row)), w, h: Math.max(2, Math.round(((pos.height ?? 200) * scale) / row)), ...(pos.z ? { z: Math.round(pos.z / 1000) } : {}) };
}

function mapVisual(name: string, vtype: string, roles: Record<string, FieldSpec[]>, pos: Record<string, number>, pageW: number, title: string | undefined, warn: (m: string) => void): VisualSpec | null {
  const def = VISUALS[vtype];
  if (!def) {
    warn(`Visual "${name}" of type ${vtype} is not supported and was skipped`);
    return null;
  }
  const fields: Record<string, FieldSpec | FieldSpec[]> = {};
  for (const [pbiRole, list] of Object.entries(roles)) {
    const role = def.roles[pbiRole];
    if (!role) {
      if (list.length) warn(`Visual "${name}": role ${pbiRole} has no PrismBI equivalent`);
      continue;
    }
    const existing = fields[role];
    const merged = [...(existing === undefined ? [] : Array.isArray(existing) ? existing : [existing]), ...list];
    fields[role] = ['value', 'field', 'x', 'y', 'size', 'target', 'trend', 'location'].includes(role) && merged.length === 1 ? merged[0] : merged;
  }
  return { id: name, type: def.type, ...(title ? { title } : {}), layout: gridLayout(pos, pageW), fields };
}

const titleOf = (objects: unknown): string | undefined => {
  const t = (objects as { title?: { properties?: { text?: { expr?: { Literal?: { Value?: string } } } } }[] })?.title?.[0]?.properties?.text?.expr?.Literal?.Value;
  return t ? t.replace(/^'|'$/g, '') : undefined;
};

/** Map a PBIR report folder (`definition/pages/<page>/page.json`, `…/visuals/<visual>/visual.json`). */
export function mapPbirReport(files: PbipFiles, warn: (m: string) => void = () => {}): ReportDefinition {
  const pageDirs = new Map<string, string>();
  for (const p of Object.keys(files)) {
    const m = /(?:^|\/)definition\/pages\/([^/]+)\/page\.json$/.exec(p);
    if (m) pageDirs.set(m[1], p.slice(0, -'page.json'.length));
  }
  const orderFile = Object.keys(files).find((p) => /(?:^|\/)definition\/pages\/pages\.json$/.test(p));
  const order: string[] = orderFile ? (JSON.parse(files[orderFile]).pageOrder ?? []) : [];
  const ids = [...order.filter((id) => pageDirs.has(id)), ...[...pageDirs.keys()].filter((id) => !order.includes(id))];
  const pages: PageDefinition[] = ids.map((id) => {
    const dir = pageDirs.get(id)!;
    const page = JSON.parse(files[`${dir}page.json`]) as { displayName?: string; width?: number; visibility?: string };
    const visuals: VisualSpec[] = [];
    for (const p of Object.keys(files)) {
      if (!p.startsWith(`${dir}visuals/`) || !p.endsWith('/visual.json')) continue;
      const v = JSON.parse(files[p]) as { name: string; position?: Record<string, number>; visual?: { visualType: string; query?: { queryState?: Record<string, { projections?: { field?: Record<string, unknown> }[] }> }; visualContainerObjects?: unknown; objects?: unknown } };
      if (!v.visual) continue;
      const roles: Record<string, FieldSpec[]> = {};
      for (const [role, st] of Object.entries(v.visual.query?.queryState ?? {})) roles[role] = (st.projections ?? []).map((pr) => fieldOf(pr.field, warn)).filter((f): f is FieldSpec => !!f);
      const mapped = mapVisual(v.name, v.visual.visualType, roles, v.position ?? {}, page.width ?? 1280, titleOf(v.visual.visualContainerObjects) ?? titleOf(v.visual.objects), warn);
      if (mapped) visuals.push(mapped);
    }
    return { id, name: page.displayName ?? id, visuals, ...(page.visibility === 'HiddenInViewMode' ? { hidden: true } : {}) };
  });
  return { pages };
}

/** Map a legacy `report.json` (PBIX-style layout: sections with stringified visual configs). */
export function mapLegacyReport(json: string, warn: (m: string) => void = () => {}): ReportDefinition {
  const layout = JSON.parse(json) as { sections?: { name: string; displayName?: string; width?: number; visualContainers?: { x: number; y: number; z?: number; width: number; height: number; config: string }[] }[] };
  const pages: PageDefinition[] = (layout.sections ?? []).map((sec) => {
    const visuals: VisualSpec[] = [];
    for (const vc of sec.visualContainers ?? []) {
      let cfg: { name?: string; singleVisual?: { visualType: string; projections?: Record<string, { queryRef: string }[]>; prototypeQuery?: { From?: { Name: string; Entity: string }[]; Select?: (Record<string, unknown> & { Name: string })[] }; vcObjects?: unknown } };
      try {
        cfg = JSON.parse(vc.config);
      } catch {
        warn('A visual has an unreadable config and was skipped');
        continue;
      }
      const sv = cfg.singleVisual;
      if (!sv) continue;
      // queryRef → field, via the prototype query's selects (aliases resolve to entities)
      const alias = new Map((sv.prototypeQuery?.From ?? []).map((f) => [f.Name, f.Entity]));
      const byRef = new Map<string, FieldSpec>();
      for (const sel of sv.prototypeQuery?.Select ?? []) {
        const resolved = JSON.parse(JSON.stringify(sel), (_k, v) => (v && typeof v === 'object' && 'Source' in v && typeof v.Source === 'string' && !('Entity' in v) ? { Entity: alias.get(v.Source) ?? v.Source } : v)) as Record<string, unknown>;
        const f = fieldOf(resolved, warn);
        if (f) byRef.set(String(sel.Name), f);
      }
      const roles: Record<string, FieldSpec[]> = {};
      for (const [role, list] of Object.entries(sv.projections ?? {})) roles[role] = list.map((p) => byRef.get(p.queryRef)).filter((f): f is FieldSpec => !!f);
      const mapped = mapVisual(cfg.name ?? `v${visuals.length}`, sv.visualType, roles, { x: vc.x, y: vc.y, z: vc.z ?? 0, width: vc.width, height: vc.height }, sec.width ?? 1280, titleOf(sv.vcObjects), warn);
      if (mapped) visuals.push(mapped);
    }
    return { id: sec.name, name: sec.displayName ?? sec.name, visuals };
  });
  return { pages };
}

// ---------------------------------------------------------------- model building

const TYPE: Record<string, DataType> = { int64: 'number', decimal: 'number', double: 'number', currency: 'number', string: 'string', dateTime: 'date', date: 'date', boolean: 'boolean', binary: 'string' };

/** Power BI format strings mostly carry over; strip escapes PrismBI does not need. */
const fmt = (f?: string) => (f ? f.replace(/\\(.)/g, '$1') : undefined);

export interface ImportOptions {
  /** Rows per table (e.g. from loadCsv / loadRest). Missing tables are created empty. */
  data?: Record<string, Row[]>;
  /**
   * A date table without rows (one built in Power Query, say) gets its date key filled over the whole years of the
   * dates related to it, so relationships and time intelligence work; its other columns stay blank. Default true.
   */
  dateTables?: boolean;
  /** Add to an existing model instead of a new one. */
  model?: DataModel;
}

export interface ImportResult {
  model: DataModel;
  report: ReportDefinition;
  /** What could not be imported, in plain language. */
  warnings: string[];
  /** The parsed semantic model, before mapping. */
  semanticModel: PbiModel;
}

/**
 * A Power BI field parameter: a calculated table of `(label, NAMEOF(field), order)` rows. It becomes a PrismBI field
 * parameter, so visuals grouped by its label column switch fields as in Power BI. False when the table isn't one.
 */
function fieldParameter(model: DataModel, t: PbiTable): (() => void) | null {
  let e;
  try {
    e = parseDax(t.calculated!);
  } catch {
    return null;
  }
  if (e.type !== 'list' || !e.items.length) return null;
  const rows = e.items.map((r) => (r.type === 'list' && r.row ? r.items : null));
  const fields: { label: string; field: string; order: number }[] = [];
  for (const r of rows) {
    const [label, name, order] = r ?? [];
    if (label?.type !== 'string' || name?.type !== 'call' || name.name.toUpperCase() !== 'NAMEOF') return null;
    const a = name.args[0];
    const field = a?.type === 'column' ? `'${a.table.replace(/'/g, "''")}'[${a.column}]` : a?.type === 'bracket' ? a.name : null;
    if (!field) return null;
    fields.push({ label: label.value, field, order: order?.type === 'number' ? order.value : fields.length });
  }
  // the label column reads [Value1]; the others (fields, order) are internal in PrismBI
  const labelCol = t.columns.find((c) => /^\[?Value1\]?$/.test(c.sourceColumn ?? ''))?.name ?? t.name;
  // added once the measures it lists exist
  return () => model.addFieldParameter(t.name, fields.sort((a, b) => a.order - b.order).map(({ label, field }) => ({ label, field })), { column: labelCol });
}

const asDate = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(v) : null;
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Rows for a date table that has no data: its date column, when relationships from other tables' date columns point
 * at it, filled with every day of the years those dates cover.
 */
function dateTableRows(pm: PbiModel, t: PbiTable, data: Record<string, Row[]>, warn: (m: string) => void): Row[] | undefined {
  const key = t.columns.find((c) => !c.expression && TYPE[c.dataType ?? ''] === 'date' && pm.relationships.some((r) => r.toTable === t.name && r.toColumn === c.name));
  if (!key) return undefined;
  let lo = Infinity;
  let hi = -Infinity;
  const sources: string[] = [];
  for (const r of pm.relationships.filter((x) => x.toTable === t.name && x.toColumn === key.name)) {
    const rows = data[r.fromTable];
    if (!rows) continue;
    sources.push(`${r.fromTable}[${r.fromColumn}]`);
    for (const row of rows) {
      const d = asDate(row[r.fromColumn]);
      if (d) (lo = Math.min(lo, d.getFullYear())), (hi = Math.max(hi, d.getFullYear()));
    }
  }
  if (!Number.isFinite(lo)) return undefined;
  const out: Row[] = [];
  for (let d = new Date(lo, 0, 1); d.getFullYear() <= hi; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push({ [key.name]: d });
  const blank = t.columns.filter((c) => c !== key && !c.expression).map((c) => c.name);
  warn(`Date table "${t.name}" has no data: generated ${t.name}[${key.name}] for ${lo}–${hi} from ${sources.join(', ')}${blank.length ? `; columns made in Power Query stay blank (${blank.join(', ')}): pass rows in data to fill them` : ''}`);
  return out;
}

/** Build a DataModel from a parsed semantic model. */
export function buildModelFrom(pm: PbiModel, opts: ImportOptions = {}, warn: (m: string) => void = () => {}): DataModel {
  const model = opts.model ?? new DataModel();
  // calculation groups become PrismBI calculation groups (their table is generated)
  for (const t of pm.tables.filter((x) => x.calculationGroup)) {
    const cg = t.calculationGroup!;
    const column = t.columns.find((c) => !/^ordinal$/i.test(c.name) && (c.dataType ?? 'string') === 'string')?.name ?? 'Name';
    try {
      model.addCalculationGroup({
        name: t.name,
        column,
        precedence: cg.precedence,
        items: [...cg.items]
          .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
          .map((it) => {
            const f = it.formatStringDefinition;
            // a plain string literal is a static format; anything else is a dynamic format expression
            const literal = f && /^"(?:[^"]|"")*"$/.test(f) ? f.slice(1, -1).replace(/""/g, '"') : undefined;
            return { name: it.name, expression: it.expression, ...(it.ordinal !== undefined ? { ordinal: it.ordinal } : {}), ...(literal !== undefined ? { format: fmt(literal) ?? literal } : f ? { formatExpression: f } : {}) };
          }),
      });
    } catch (e) {
      warn(`Calculation group "${t.name}": ${(e as Error).message}`);
    }
  }
  const physical = pm.tables.filter((t) => !t.calculated && !t.calculationGroup);
  for (const t of physical) {
    const schema: Record<string, ColumnSchema> = {};
    const baseCols = t.columns.filter((c) => !c.expression);
    // sort-by columns must be base columns of the same table (calculated ones are added later)
    const base = new Set(baseCols.map((c) => c.name));
    for (const c of baseCols) schema[c.name] = { type: TYPE[c.dataType ?? ''] ?? undefined, format: fmt(c.formatString), hidden: c.isHidden || t.isHidden, description: c.description, folder: c.displayFolder, sortBy: c.sortByColumn && base.has(c.sortByColumn) ? c.sortByColumn : undefined } as ColumnSchema;
    const rows = opts.data?.[t.name] ?? (opts.dateTables === false ? undefined : dateTableRows(pm, t, opts.data ?? {}, warn));
    if (rows) model.addTable(t.name, rows, schema);
    else {
      if (!opts.data || Object.keys(opts.data).length) warn(`No data for table "${t.name}": created empty`);
      model.addTable(t.name, DataTable.fromColumns(t.name, Object.fromEntries(baseCols.map((c) => [c.name, []])), schema));
    }
  }
  // relationships to calculated tables (auto date tables, say) wait until those tables exist
  const calculatedNames = new Set(pm.tables.filter((t) => t.calculated).map((t) => t.name));
  const addRel = (r: PbiRelationship) => {
    try {
      model.addRelationship({ from: ref(r.fromTable, r.fromColumn), to: ref(r.toTable, r.toColumn), active: r.isActive !== false, crossFilter: r.crossFilteringBehavior === 'bothDirections' ? 'both' : 'single' });
    } catch (e) {
      warn(`Relationship ${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]: ${(e as Error).message}`);
    }
  };
  const later = pm.relationships.filter((r) => calculatedNames.has(r.fromTable) || calculatedNames.has(r.toTable));
  for (const r of pm.relationships) if (!later.includes(r)) addRel(r);
  for (const t of physical)
    for (const c of t.columns.filter((x) => x.expression)) {
      try {
        model.addCalculatedColumn(t.name, c.name, c.expression!, { format: fmt(c.formatString), hidden: c.isHidden });
      } catch (e) {
        warn(`Calculated column ${t.name}[${c.name}]: ${(e as Error).message}`);
      }
    }
  const params: [string, () => void][] = [];
  for (const t of pm.tables.filter((x) => x.calculated)) {
    try {
      const param = fieldParameter(model, t);
      if (param) {
        params.push([t.name, param]);
        continue;
      }
      // name the columns as the model declares them (a table constructor's columns are Value1, Value2, …)
      const base = t.columns.filter((c) => !c.expression);
      const src = (c: PbiColumn) => (c.sourceColumn ?? c.name).replace(/^\[|\]$/g, '').replace(/^.*\[(.*)\]$/, '$1');
      const renamed = base.some((c) => src(c) !== c.name);
      const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;
      model.addCalculatedTable(t.name, renamed ? `SELECTCOLUMNS(${t.calculated}, ${base.map((c) => `${quote(c.name)}, [${src(c).replace(/]/g, ']]')}]`).join(', ')})` : t.calculated!);
      for (const c of t.columns.filter((x) => x.expression))
        try {
          model.addCalculatedColumn(t.name, c.name, c.expression!, { format: fmt(c.formatString), hidden: c.isHidden });
        } catch (e) {
          warn(`Calculated column ${t.name}[${c.name}]: ${(e as Error).message}`);
        }
    } catch (e) {
      warn(`Calculated table ${t.name}: ${(e as Error).message}`);
    }
  }
  for (const r of later) addRel(r);
  for (const t of pm.tables.filter((x) => !x.calculationGroup || x.measures.length))
    for (const m of t.measures) {
      if (!m.expression) continue;
      try {
        model.addMeasure(m.name, m.expression, { format: fmt(m.formatString), table: t.name, folder: m.displayFolder, description: m.description, hidden: m.isHidden } as never);
      } catch (e) {
        warn(`Measure [${m.name}]: ${(e as Error).message}`);
        continue;
      }
      // unsupported functions only surface when evaluated: try once and keep the measure either way
      try {
        model.evaluate(`[${m.name.replace(/]/g, ']]')}]`);
      } catch (e) {
        warn(`Measure [${m.name}]: ${(e as Error).message}`);
      }
    }
  for (const [name, add] of params)
    try {
      add();
    } catch (e) {
      warn(`Field parameter "${name}": ${(e as Error).message}`);
    }
  // aggregation tables: columns that are "alternate of" detail columns
  for (const t of pm.tables) {
    const alts = t.columns.filter((c) => c.alternateOf);
    if (!alts.length) continue;
    const def: { table: string; detail: string; groupBy: Record<string, string>; columns: Record<string, Record<string, string>>; rows?: string } = { table: t.name, detail: '', groupBy: {}, columns: {} };
    let ok = true;
    for (const c of alts) {
      const a = c.alternateOf!;
      const how = (a.summarization ?? '').toLowerCase();
      const [bt, bc] = a.baseColumn ? (/\[/.test(a.baseColumn) ? [a.baseColumn.replace(/^'?(.*?)'?\[.*$/, '$1'), a.baseColumn.replace(/^.*\[(.*)\]$/, '$1')] : splitRef(a.baseColumn)) : [a.baseTable ?? '', ''];
      if (def.detail && def.detail !== bt) ok = false;
      def.detail = bt;
      if (!bc && how === 'count') def.rows = c.name;
      else if (how === 'groupby') def.groupBy[bc] = c.name;
      else if (['sum', 'min', 'max', 'count'].includes(how)) (def.columns[bc] ??= {})[how] = c.name;
      else ok = false;
    }
    if (!ok || !def.detail) {
      warn(`Aggregation table "${t.name}": unsupported mapping (one detail table; groupBy, sum, min, max, count)`);
      continue;
    }
    try {
      model.addAggregation(def);
    } catch (e) {
      warn(`Aggregation table "${t.name}": ${(e as Error).message}`);
    }
  }
  return model;
}

const norm = (files: PbipFiles): PbipFiles => Object.fromEntries(Object.entries(files).map(([k, v]) => [k.replace(/\\/g, '/').replace(/^\.\//, ''), v]));

/** Auto date/time levels (Orders[OrderDate] › Year) → the hidden date table's column (LocalDateTable_…[Year]). */
function resolveVariations(report: ReportDefinition, pm: PbiModel, warn: (m: string) => void): ReportDefinition {
  const fix = (s: string): string => {
    const [col, level] = s.split(VARIATION);
    const m = /^'?(.*?)'?\[(.*)\]$/.exec(col);
    const table = m?.[1].replace(/''/g, "'");
    // the column's variation names its date table; otherwise follow its relationship (the active one first)
    const declared = m && pm.tables.find((t) => t.name === table)?.columns.find((c) => c.name === m[2])?.variation?.defaultHierarchy;
    if (declared) return ref(splitRef(declared)[0], level);
    const r = m && [...pm.relationships].sort((a, b) => Number(b.isActive !== false) - Number(a.isActive !== false)).find((x) => x.fromTable === table && x.fromColumn === m[2]);
    if (r) return ref(r.toTable, level);
    warn(`${col} › ${level}: no date table behind it; grouped by the date itself`);
    return col;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.includes(VARIATION) ? fix(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(report) as ReportDefinition;
}

/** Import a `.pbip` project: the semantic model, the report, and warnings for anything left out. */
export function importPowerBI(input: PbipFiles, opts: ImportOptions = {}): ImportResult {
  const files = norm(input);
  const warnings: string[] = [];
  const warn = (m: string) => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const tmdl = Object.keys(files).filter((p) => /\.SemanticModel\/definition\/.*\.tmdl$/i.test(p) || (/(?:^|\/)definition\/.*\.tmdl$/.test(p) && !/\.Report\//.test(p)));
  const bim = Object.keys(files).find((p) => /model\.bim$/i.test(p));
  let pm: PbiModel = { tables: [], relationships: [] };
  if (tmdl.length) pm = parseTmdl(tmdl.sort().map((p) => files[p]));
  else if (bim) pm = parseModelBim(files[bim]);
  else warn('No semantic model found (expected *.SemanticModel/definition/*.tmdl or model.bim)');
  const model = buildModelFrom(pm, opts, warn);
  let report: ReportDefinition = { pages: [] };
  const pbir = Object.keys(files).some((p) => /definition\/pages\/[^/]+\/page\.json$/.test(p));
  const legacy = Object.keys(files).find((p) => /\.Report\/report\.json$/i.test(p) || /(?:^|\/)report\.json$/i.test(p));
  if (pbir) report = mapPbirReport(files, warn);
  else if (legacy) report = mapLegacyReport(files[legacy], warn);
  else warn('No report found (expected *.Report/definition/pages or report.json)');
  report = resolveVariations(report, pm, warn);
  // fields that refer to things the model does not have
  const known = (f: FieldSpec) => {
    const s = typeof f === 'string' ? f : (f.field ?? '');
    if (!s) return true;
    if (!s.includes('[')) return model.hasMeasure(s);
    const m = /^'?(.*?)'?\[(.*)\]$/.exec(s);
    return !!m && model.hasTable(m[1].replace(/''/g, "'")) && model.table(m[1].replace(/''/g, "'")).hasColumn(m[2]);
  };
  for (const p of report.pages)
    for (const v of p.visuals)
      for (const [role, f] of Object.entries(v.fields ?? {})) for (const x of Array.isArray(f) ? f : [f]) if (!known(x)) warn(`Visual "${v.id}" (${role}) refers to ${typeof x === 'string' ? x : x.field}, which the model does not have`);
  return { model, report, warnings, semanticModel: pm };
}
