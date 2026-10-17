import type { DataModel } from '../data/model';
import type { Report } from '../report/report';

/** What studio panes need from the studio. */
export interface StudioContext {
  readonly model: DataModel;
  readonly report: Report;
  /** Host element for dialogs and toasts. */
  readonly root: HTMLElement;
  selected(): string | null;
  /** Click on a field: add it to the selected visual, or create a visual for it. */
  addField(ref: string): void;
  /** Put a field into a visual's well. */
  assign(visualId: string, ref: string, role?: string, index?: number): void;
  addVisual(type: string): void;
  setVisualType(type: string): void;
  /** Record an undo step (after model edits). */
  commit(): void;
  editMeasure(name?: string): void;
  deleteMeasure(name: string): void;
  editColumn(table?: string, name?: string): void;
  deleteColumn(table: string, name: string): void;
  isStudioColumn(table: string, name: string): boolean;
  /** Theme overrides edited in the format pane. */
  themeOverrides(): Record<string, unknown>;
  setThemeOverrides(patch: Record<string, unknown>): void;
  toast(message: string): void;
}

/** dataTransfer type used for dragging fields and well chips. */
export const FIELD_MIME = 'application/x-prismbi-field';
export const CHIP_MIME = 'application/x-prismbi-chip';
