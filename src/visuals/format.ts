import type { DisplayUnits } from '../format/format';

/** Every visual's format pane. Visual-specific sections live alongside (index signature). */
export interface VisualFormat {
  title: { show: boolean; text?: string; subtitle?: string; fontSize?: number; color?: string; align: 'left' | 'center' | 'right'; bold: boolean };
  background: { show: boolean; color?: string; transparency: number };
  border: { show: boolean; color?: string; width: number; radius?: number };
  shadow: { show: boolean };
  padding: number;
  header: { show: boolean; focusMode: boolean; exportData: boolean; showAsTable: boolean; drill: boolean };
  tooltip: { show: boolean };
  legend: { show: boolean | 'auto'; position: 'top' | 'bottom' | 'left' | 'right'; fontSize?: number };
  dataLabels: {
    show: boolean;
    format?: string;
    displayUnits: DisplayUnits;
    decimals?: number;
    fontSize?: number;
    color?: string;
    position: 'auto' | 'inside' | 'outside';
  };
  categoryAxis: { show: boolean; title?: string | boolean; fontSize?: number; maxLabelWidth: number; labelAngle: 'auto' | 0 | 45 | 90; gridlines: boolean };
  valueAxis: {
    show: boolean;
    title?: string | boolean;
    format?: string;
    displayUnits: DisplayUnits;
    decimals?: number;
    min?: number;
    max?: number;
    gridlines: boolean;
    tickCount: number;
  };
  colors: {
    /** Fixed colour per series name (measure name or legend value). */
    series?: Record<string, string>;
    /** Fixed colour per category value. */
    categories?: Record<string, string>;
    /** Colour for single-series charts. */
    default?: string;
    /** Replace the theme palette for this visual. */
    palette?: string[];
  };
  bars: { maxThickness: number; radius: number; gap: number; categoryGap: number };
  lines: { width: number; markers: boolean | 'auto'; smooth: boolean; area: boolean; areaOpacity: number; endLabels: boolean };
  animation: { enabled: boolean; duration: number };
  [section: string]: unknown;
}

export const baseFormat: VisualFormat = {
  title: { show: true, align: 'left', bold: true },
  background: { show: true, transparency: 0 },
  border: { show: true, width: 1 },
  shadow: { show: false },
  padding: 12,
  header: { show: true, focusMode: true, exportData: true, showAsTable: true, drill: true },
  tooltip: { show: true },
  legend: { show: 'auto', position: 'top' },
  dataLabels: { show: false, displayUnits: 'auto', position: 'auto' },
  categoryAxis: { show: true, maxLabelWidth: 120, labelAngle: 'auto', gridlines: false },
  valueAxis: { show: true, displayUnits: 'auto', gridlines: true, tickCount: 5 },
  colors: {},
  bars: { maxThickness: 24, radius: 4, gap: 2, categoryGap: 0.35 },
  lines: { width: 2, markers: 'auto', smooth: false, area: false, areaOpacity: 0.1, endLabels: true },
  animation: { enabled: true, duration: 280 },
};
