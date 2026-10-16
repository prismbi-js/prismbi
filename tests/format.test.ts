import { describe, expect, it } from 'vitest';
import { formatValue, linearScale, squarify } from '../src/index';
import { relativeRange } from '../src/visuals/slicer';

describe('formatValue', () => {
  it('formats numbers with Power BI-style patterns', () => {
    expect(formatValue(1234567.891, '#,0')).toBe('1,234,568');
    expect(formatValue(1234.5, '#,0.00')).toBe('1,234.50');
    expect(formatValue(0.1234, '0.0%')).toBe('12.3%');
    expect(formatValue(1234, '$#,0')).toBe('$1,234');
    expect(formatValue(-1234, '$#,0')).toBe('-$1,234');
    expect(formatValue(5, '000')).toBe('005');
    expect(formatValue(12345, '0.00E+00')).toBe('1.23E+4');
    expect(formatValue(1234567, '#,0,')).toBe('1,235');
  });

  it('applies display units', () => {
    expect(formatValue(1_500_000, '$#,0', { displayUnits: 'auto' })).toBe('$1.5M');
    expect(formatValue(9_062_000, '$#,0', { displayUnits: 'auto' })).toBe('$9.06M');
    expect(formatValue(1_500_000, undefined, { displayUnits: 'auto' })).toBe('1.5M');
    expect(formatValue(12_300, undefined, { displayUnits: 'thousands' })).toBe('12.3K');
    expect(formatValue(980, undefined, { displayUnits: 'auto' })).toBe('980');
  });

  it('formats dates', () => {
    const d = new Date(2024, 2, 5, 14, 7);
    expect(formatValue(d, 'yyyy-MM-dd')).toBe('2024-03-05');
    expect(formatValue(d, 'MMM yyyy')).toBe('Mar 2024');
    expect(formatValue(d, 'dddd, MMMM d')).toBe('Tuesday, March 5');
    expect(formatValue(d, 'hh:mm tt')).toBe('02:07 PM');
    expect(formatValue(d, '"Q"q yyyy')).toBe('Q1 2024');
  });

  it('handles blanks, booleans and presets', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(null, undefined, { blank: '(Blank)' })).toBe('(Blank)');
    expect(formatValue(true)).toBe('True');
    expect(formatValue(0.5, 'percent')).toBe('50.0%');
  });
});

describe('scales & layout', () => {
  it('linear scale produces nice ticks including zero', () => {
    const s = linearScale(3, 87, [100, 0]);
    expect(s.ticks[0]).toBe(0);
    expect(s.ticks[s.ticks.length - 1]).toBeGreaterThanOrEqual(87);
    expect(s(0)).toBe(100);
  });

  it('squarify fills the rectangle', () => {
    const rects = squarify([6, 6, 4, 3, 2, 2, 1], { x: 0, y: 0, w: 600, h: 400 });
    const area = rects.reduce((a, r) => a + r.w * r.h, 0);
    expect(area).toBeCloseTo(600 * 400, 3);
  });

  it('relative date ranges', () => {
    const today = new Date(2025, 5, 15);
    expect(relativeRange('last', 7, 'days', true, today)).toEqual([new Date(2025, 5, 9), new Date(2025, 5, 15)]);
    expect(relativeRange('this', 1, 'months', true, today)).toEqual([new Date(2025, 5, 1), new Date(2025, 5, 30)]);
    expect(relativeRange('next', 1, 'years', true, today)[1]).toEqual(new Date(2026, 5, 14));
  });
});
