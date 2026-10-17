import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Report, createVisual } from '@prismbi/prismbi';
import type { DataModel, DeepPartial, FilterSpec, ReportChrome, ReportDefinition, ReportEvents, Theme, VisualSpec } from '@prismbi/prismbi';
import { Studio } from '@prismbi/prismbi/studio';
import type { StudioDocument } from '@prismbi/prismbi/studio';

type ThemeProp = string | Theme | DeepPartial<Theme>;

type EventProps = {
  onSelectionChanged?: (e: ReportEvents['selectionChanged']) => void;
  onFiltersChanged?: (e: ReportEvents['filtersChanged']) => void;
  onPageChanged?: (e: ReportEvents['pageChanged']) => void;
  onDataPointClick?: (e: ReportEvents['dataPointClick']) => void;
  onDrill?: (e: ReportEvents['drill']) => void;
  onError?: (e: ReportEvents['error']) => void;
  onRendered?: (e: ReportEvents['rendered']) => void;
};

const EVENT_PROPS: Record<keyof EventProps, keyof ReportEvents> = {
  onSelectionChanged: 'selectionChanged',
  onFiltersChanged: 'filtersChanged',
  onPageChanged: 'pageChanged',
  onDataPointClick: 'dataPointClick',
  onDrill: 'drill',
  onError: 'error',
  onRendered: 'rendered',
};

function useEventProps(report: Report | null, props: EventProps): void {
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => {
    if (!report) return;
    const offs = (Object.keys(EVENT_PROPS) as (keyof EventProps)[]).map((k) =>
      report.on(EVENT_PROPS[k], (payload) => (latest.current[k] as ((p: unknown) => void) | undefined)?.(payload)),
    );
    return () => offs.forEach((off) => off());
  }, [report]);
}

export interface PrismReportProps extends EventProps {
  model: DataModel;
  /** Report definition (pages, visuals, filters). Changing its identity rebuilds the report. */
  definition: ReportDefinition;
  theme?: ThemeProp;
  locale?: string;
  chrome?: ReportChrome;
  /** Controlled page (id or name). */
  page?: string;
  /** Controlled report-level filters. */
  filters?: FilterSpec[];
  className?: string;
  style?: CSSProperties;
}

/** Full interactive report. Use a ref to reach the imperative {@link Report} API. */
export const PrismReport = forwardRef<Report | null, PrismReportProps>(function PrismReport(props, ref) {
  const { model, definition, theme, locale, chrome, page, filters, className, style } = props;
  const el = useRef<HTMLDivElement>(null);
  const [report, setReport] = useState<Report | null>(null);
  useImperativeHandle(ref, () => report as Report, [report]);

  useEffect(() => {
    if (!el.current) return;
    const r = new Report(el.current, { ...definition, model, theme, locale, chrome, initialPage: page });
    setReport(r);
    return () => r.destroy();
    // theme / page / filters are applied incrementally below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, definition, locale, chrome]);

  useEffect(() => {
    if (report && theme) report.setTheme(theme);
  }, [report, theme]);
  useEffect(() => {
    if (report && page && report.currentPage.id !== page && report.currentPage.name !== page) report.goToPage(page);
  }, [report, page]);
  useEffect(() => {
    if (report && filters) report.setReportFilters(filters);
  }, [report, filters]);
  useEventProps(report, props);

  return <div ref={el} className={className} style={{ height: '100%', minHeight: 320, ...style }} />;
});

export interface PrismVisualProps extends EventProps, Omit<VisualSpec, 'layout' | 'id' | 'style' | 'className'> {
  model: DataModel;
  theme?: ThemeProp;
  locale?: string;
  className?: string;
  style?: CSSProperties;
}

/** A single visual you can place anywhere in your own layout. */
export const PrismVisual = forwardRef<Report | null, PrismVisualProps>(function PrismVisual(props, ref) {
  const { model, theme, locale, className, style, type, title, fields, filters, format, sort, top, interaction } = props;
  const el = useRef<HTMLDivElement>(null);
  const [report, setReport] = useState<Report | null>(null);
  useImperativeHandle(ref, () => report as Report, [report]);
  const specKey = JSON.stringify({ type, title, fields, filters, format, sort, top, interaction });

  useEffect(() => {
    if (!el.current) return;
    const r = createVisual(el.current, { model, theme, locale, type, title, fields, filters, format, sort, top, interaction });
    setReport(r);
    return () => r.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, locale]);

  useEffect(() => {
    if (!report) return;
    const id = report.visualIds()[0];
    report.updateVisual(id, { type, title, fields, filters, format, sort, top, interaction });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, specKey]);
  useEffect(() => {
    if (report && theme) report.setTheme(theme);
  }, [report, theme]);
  useEventProps(report, props);

  return <div ref={el} className={className} style={{ height: 300, ...style }} />;
});

/** Imperative access from a ref: `const ref = usePrismReport(); <PrismReport ref={ref} />; ref.current?.goToPage('Details')`. */
export function usePrismReport() {
  return useRef<Report | null>(null);
}

export interface PrismStudioProps {
  model: DataModel;
  /** Document to open. Changing its identity reopens it. */
  document?: StudioDocument;
  /** Autosave key (localStorage). */
  storageKey?: string;
  theme?: 'light' | 'dark' | DeepPartial<Theme>;
  /** Fires after every change (debounced per action) with the full document. */
  onChange?: (doc: StudioDocument) => void;
  onSave?: (doc: StudioDocument) => void;
  preview?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** The drag-and-drop report editor. Use a ref to reach the imperative {@link Studio} API. */
export const PrismStudio = forwardRef<Studio | null, PrismStudioProps>(function PrismStudio(props, ref) {
  const { model, document: doc, storageKey, theme, preview, className, style } = props;
  const el = useRef<HTMLDivElement>(null);
  const [studio, setStudio] = useState<Studio | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useImperativeHandle(ref, () => studio as Studio, [studio]);

  useEffect(() => {
    if (!el.current) return;
    const s = new Studio(el.current, { model, document: doc, storageKey, theme, preview });
    const offs = [s.on('change', (d) => latest.current.onChange?.(d)), s.on('save', (d) => latest.current.onSave?.(d))];
    setStudio(s);
    return () => {
      offs.forEach((off) => off());
      s.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, doc, storageKey]);
  useEffect(() => {
    if (studio && preview !== undefined) studio.setPreview(preview);
  }, [studio, preview]);

  return <div ref={el} className={className} style={{ height: '100%', minHeight: 520, ...style }} />;
});

export type { Report, Studio, StudioDocument };
