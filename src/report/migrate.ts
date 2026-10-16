import type { ReportDefinition } from './report';

/** Current report JSON schema version. Bump it and add a step to `MIGRATIONS` on breaking changes. */
export const REPORT_SCHEMA_VERSION = 1;

type AnyReport = Record<string, unknown> & { version?: number; pages?: Record<string, unknown>[] };

/** Ordered migration steps: `MIGRATIONS[n]` upgrades version n → n + 1. */
const MIGRATIONS: ((r: AnyReport) => AnyReport)[] = [
  // 0 → 1: early drafts used `format.style` on slicers and `axis` as the line category role
  (r) => {
    for (const p of r.pages ?? []) {
      for (const v of (p.visuals as Record<string, any>[] | undefined) ?? []) {
        if (v.type === 'slicer' && v.format?.style && !v.format?.slicer) {
          v.format.slicer = { style: v.format.style };
          delete v.format.style;
        }
        if (v.fields?.axis && !v.fields?.category && ['line', 'area', 'stackedArea', 'clusteredColumn', 'clusteredBar'].includes(v.type)) {
          v.fields.category = v.fields.axis;
          delete v.fields.axis;
        }
      }
    }
    return r;
  },
];

/**
 * Upgrade a saved report definition (object or JSON string) to the current schema.
 * Throws for definitions written by a newer version of PrismBI.
 */
export function migrateReport(input: unknown, revive?: (k: string, v: unknown) => unknown): ReportDefinition {
  const r: AnyReport = typeof input === 'string' ? JSON.parse(input, revive) : structuredClone(input as AnyReport);
  if (!r || typeof r !== 'object' || !Array.isArray(r.pages)) throw new Error('Not a report definition: expected an object with a "pages" array');
  let v = typeof r.version === 'number' ? r.version : 0;
  if (v > REPORT_SCHEMA_VERSION) throw new Error(`This report was saved by a newer PrismBI (schema ${v}); this version reads up to ${REPORT_SCHEMA_VERSION}`);
  let out = r;
  while (v < REPORT_SCHEMA_VERSION) out = MIGRATIONS[v++](out);
  out.version = REPORT_SCHEMA_VERSION;
  return out as unknown as ReportDefinition;
}
