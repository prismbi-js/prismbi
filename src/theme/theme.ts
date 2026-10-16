import type { DeepPartial } from '../utils';
import { deepMerge } from '../utils';
import type { VisualFormat } from '../visuals/format';

export interface Theme {
  name: string;
  mode: 'light' | 'dark';
  /** Categorical palette, assigned in fixed order (never cycled). */
  dataColors: string[];
  /** Colour used for the folded "Other" bucket once dataColors run out. */
  otherColor: string;
  /** Report page plane. */
  background: string;
  /** Visual surface. */
  surface: string;
  foreground: string;
  foregroundSecondary: string;
  foregroundMuted: string;
  gridline: string;
  axis: string;
  border: string;
  /** Selection / focus / table accent. */
  accent: string;
  good: string;
  bad: string;
  warning: string;
  neutral: string;
  /** Sequential ramp (min → max), single hue. */
  sequential: string[];
  /** Diverging [negative, neutral, positive]. */
  diverging: [string, string, string];
  fontFamily: string;
  fontSize: number;
  titleFontSize: number;
  calloutFontSize: number;
  labelFontSize: number;
  radius: number;
  /** Default format overrides per visual type (`'*'` applies to all). */
  visualStyles?: Record<string, DeepPartial<VisualFormat>>;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const lightTheme: Theme = {
  name: 'light',
  mode: 'light',
  dataColors: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  otherColor: '#898781',
  background: '#f9f9f7',
  surface: '#fcfcfb',
  foreground: '#0b0b0b',
  foregroundSecondary: '#52514e',
  foregroundMuted: '#898781',
  gridline: '#e1e0d9',
  axis: '#c3c2b7',
  border: 'rgba(11,11,11,0.10)',
  accent: '#2a78d6',
  good: '#0ca30c',
  bad: '#d03b3b',
  warning: '#fab219',
  neutral: '#898781',
  sequential: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
  diverging: ['#2a78d6', '#f0efec', '#e34948'],
  fontFamily: FONT,
  fontSize: 12,
  titleFontSize: 14,
  calloutFontSize: 36,
  labelFontSize: 11,
  radius: 8,
};

export const darkTheme: Theme = {
  ...lightTheme,
  name: 'dark',
  mode: 'dark',
  dataColors: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  background: '#0d0d0d',
  surface: '#1a1a19',
  foreground: '#f0efec',
  foregroundSecondary: '#c3c2b7',
  foregroundMuted: '#898781',
  gridline: '#2c2c2a',
  axis: '#383835',
  border: 'rgba(255,255,255,0.10)',
  accent: '#3987e5',
  sequential: ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
  diverging: ['#3987e5', '#383835', '#e66767'],
};

const registry = new Map<string, Theme>([
  ['light', lightTheme],
  ['dark', darkTheme],
]);

export function registerTheme(theme: Theme): void {
  registry.set(theme.name, theme);
}

export function getTheme(t?: string | Theme | DeepPartial<Theme>): Theme {
  if (!t) return lightTheme;
  if (typeof t === 'string') {
    const found = registry.get(t);
    if (!found) throw new Error(`Unknown theme "${t}". Registered: ${[...registry.keys()].join(', ')}`);
    return found;
  }
  return createTheme(t);
}

/** Create a theme by overriding a base theme. */
export function createTheme(overrides: DeepPartial<Theme>, base: Theme = overrides.mode === 'dark' ? darkTheme : lightTheme): Theme {
  return deepMerge(base, overrides as Partial<Theme>);
}

/** Subset of the Power BI report theme JSON format. */
export interface PowerBIThemeJson {
  name: string;
  dataColors?: string[];
  background?: string;
  foreground?: string;
  tableAccent?: string;
  good?: string;
  bad?: string;
  neutral?: string;
  maximum?: string;
  center?: string;
  minimum?: string;
  textClasses?: Record<string, { fontSize?: number; fontFace?: string; color?: string }>;
}

/** Import a Power BI theme JSON file (colours, fonts, sentiment, divergent). */
export function fromPowerBITheme(json: PowerBIThemeJson, base: Theme = lightTheme): Theme {
  const tc = json.textClasses ?? {};
  return createTheme(
    {
      name: json.name,
      dataColors: json.dataColors,
      surface: json.background,
      foreground: json.foreground,
      accent: json.tableAccent,
      good: json.good,
      bad: json.bad,
      neutral: json.neutral,
      diverging: json.minimum && json.center && json.maximum ? [json.minimum, json.center, json.maximum] : undefined,
      fontFamily: tc.label?.fontFace ?? tc.callout?.fontFace,
      fontSize: tc.label?.fontSize ? Math.round(tc.label.fontSize * 1.333) : undefined,
      titleFontSize: tc.title?.fontSize ? Math.round(tc.title.fontSize * 1.333) : undefined,
      calloutFontSize: tc.callout?.fontSize ? Math.round(tc.callout.fontSize * 1.333) : undefined,
    },
    base,
  );
}
