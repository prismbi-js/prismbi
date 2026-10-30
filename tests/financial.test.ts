import { describe, expect, it } from 'vitest';
import { DataModel } from '../src/index';

describe('periodic financial DAX functions', () => {
  const model = new DataModel()
    .addTable('Loans', [
      { Id: 1, Rate: 0.08 / 12, Nper: 10, Pv: 10000 },
      { Id: 2, Rate: 0.05 / 12, Nper: 60, Pv: 25000 },
    ])
    .addTable('CashFlows', [
      { Project: 'A', Period: 0, Amount: -10000 },
      { Project: 'A', Period: 1, Amount: 3000 },
      { Project: 'A', Period: 2, Amount: 4200 },
      { Project: 'A', Period: 3, Amount: 6800 },
    ]);

  it('calculates PMT loan payments accurately', () => {
    // Standard 10-month loan at 8% annual
    const pmt = model.evaluate('PMT(0.08 / 12, 10, 10000)') as number;
    expect(pmt).toBeCloseTo(-1037.032, 2);

    // Zero interest loan
    const pmtZero = model.evaluate('PMT(0, 10, 10000)') as number;
    expect(pmtZero).toBe(-1000);

    // Payment at beginning of period (type = 1)
    const pmtBeg = model.evaluate('PMT(0.08 / 12, 10, 10000, 0, 1)') as number;
    expect(pmtBeg).toBeCloseTo(-1030.164, 2);
  });

  it('calculates PV and FV roundtrips', () => {
    const pmt = model.evaluate('PMT(0.08 / 12, 10, 10000)') as number;
    const pv = model.evaluate(`PV(0.08 / 12, 10, ${pmt})`) as number;
    expect(pv).toBeCloseTo(10000, 2);

    const fv = model.evaluate(`FV(0.08 / 12, 10, ${pmt}, 10000)`) as number;
    expect(fv).toBeCloseTo(0, 2);
  });

  it('calculates NPER period counts', () => {
    const nper = model.evaluate('NPER(0.08 / 12, -1037.032089, 10000)') as number;
    expect(nper).toBeCloseTo(10, 2);
  });

  it('calculates IPMT and PPMT amortization schedules', () => {
    const ipmt1 = model.evaluate('IPMT(0.08 / 12, 1, 10, 10000)') as number;
    const ppmt1 = model.evaluate('PPMT(0.08 / 12, 1, 10, 10000)') as number;
    const pmt = model.evaluate('PMT(0.08 / 12, 10, 10000)') as number;

    expect(ipmt1).toBeCloseTo(-66.67, 2);
    expect(ppmt1).toBeCloseTo(-970.37, 2);
    expect(ipmt1 + ppmt1).toBeCloseTo(pmt, 4);

    const ipmt10 = model.evaluate('IPMT(0.08 / 12, 10, 10, 10000)') as number;
    const ppmt10 = model.evaluate('PPMT(0.08 / 12, 10, 10, 10000)') as number;
    expect(ipmt10).toBeCloseTo(-6.87, 2);
    expect(ppmt10).toBeCloseTo(-1030.16, 2);
    expect(ipmt10 + ppmt10).toBeCloseTo(pmt, 4);
  });

  it('calculates RATE interest rate solver', () => {
    const rate = model.evaluate('RATE(10, -1037.032089, 10000)') as number;
    expect(rate * 12).toBeCloseTo(0.08, 3);
  });

  it('calculates IRR internal rate of return for periodic cash flows', () => {
    // Array / table constructor
    const irr = model.evaluate('IRR({ -10000, 3000, 4200, 6800 })') as number;
    expect(irr).toBeCloseTo(0.1634, 3);

    // Column ref
    const irrCol = model.evaluate('IRR(CashFlows[Amount])') as number;
    expect(irrCol).toBeCloseTo(0.1634, 3);
  });
});

