import type { CellValue } from '../data/types';
import type { FilterSpec } from '../data/filters';
import type { DataPointIdentity } from '../visuals/types';

export interface ReportEvents {
  [key: string]: unknown;
  pageChanged: { pageId: string; name: string };
  selectionChanged: { pageId: string; visualId: string | null; identities: DataPointIdentity[]; filters: FilterSpec[] };
  filtersChanged: { pageId: string; scope: 'report' | 'page' | 'visual' | 'slicer'; visualId?: string; filters: FilterSpec[] };
  dataPointClick: { visualId: string; keys: CellValue[]; identity: DataPointIdentity; event: MouseEvent };
  drill: { visualId: string; level: number; path: CellValue[] };
  rendered: { visualId: string; ms: number };
  error: { visualId: string; error: Error };
  themeChanged: { name: string };
  bookmarkApplied: { name: string };
  drillThrough: { fromPageId: string; toPageId: string; visualId?: string; filters: FilterSpec[] };
  /** Something in the report definition changed (pages, visuals, layout, filters, interactions). */
  definitionChanged: { reason: string };
  /** Design-time selection changed (edit mode) or a visual was activated. */
  visualSelected: { visualId: string | null };
}
