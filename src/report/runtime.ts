import type { DataModel } from '../data/model';
import type { FilterSpec } from '../data/filters';
import type { CellValue } from '../data/types';
import type { Theme } from '../theme/theme';
import type { DataPointIdentity } from '../visuals/types';
import type { Tooltip } from './tooltip';
import type { ReportEvents } from './events';
import type { MenuItem } from './contextMenu';

/** What a VisualHost needs from the report it lives in. */
export interface ReportRuntime {
  readonly model: DataModel;
  readonly theme: Theme;
  readonly locale?: string;
  readonly modelVersion: number;
  readonly tooltip: Tooltip;
  readonly focused: string | null;
  schedule(visualId?: string): void;
  emit<K extends keyof ReportEvents>(event: K, payload: ReportEvents[K]): void;
  filtersFor(visualId: string): FilterSpec[];
  highlightFor(visualId: string): FilterSpec[] | undefined;
  selectionFor(visualId: string): DataPointIdentity[];
  selectionSource(): string | null;
  setSelection(visualId: string, identity: DataPointIdentity | null, multi: boolean): void;
  clearSelectionFrom(visualId: string): void;
  slicerFilter(visualId: string): FilterSpec[] | null;
  setSlicerFilter(visualId: string, filters: FilterSpec[] | null): void;
  slicerDomain(visualId: string, column: string): CellValue[];
  setActiveVisual(visualId: string | null): void;
  toggleFocus(visualId: string): void;
  domainIndex(table: string, column: string, value: CellValue): number;
  slicerTuples(visualId: string, columns: string[]): CellValue[][];
  showContextMenu(visualId: string, identity: DataPointIdentity, evt: MouseEvent): void;
  menu(x: number, y: number, items: MenuItem[]): void;
}
