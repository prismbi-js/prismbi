import { describe, expect, it } from 'vitest';
import { daxCopilot, explainDax, writeDax, writeDaxSync } from '@prismbi/prismbi/ai';
import { Studio } from '@prismbi/prismbi/studio';
import { buildModel } from '../examples/model';

const model = buildModel();
const w = (q: string) => writeDaxSync(model, q);

describe('writeDaxSync', () => {
  it('writes time intelligence from plain English', () => {
    expect(w('sales year to date')).toMatchObject({ expression: 'TOTALYTD([Total Sales], Date[Date])', name: 'Total Sales YTD', source: 'rules' });
    expect(w('profit last year').expression).toBe('CALCULATE([Total Profit], SAMEPERIODLASTYEAR(Date[Date]))');
    expect(w('sales yoy %')).toMatchObject({ format: '0.0%', name: 'Total Sales YoY %' });
    expect(w('sales yoy %').expression).toContain('DIVIDE([Total Sales] - Prev, Prev)');
    expect(w('change in units vs last year').expression).toBe('[Units] - CALCULATE([Units], SAMEPERIODLASTYEAR(Date[Date]))');
    expect(w('running total of orders').expression).toBe('CALCULATE([Orders], FILTER(ALLSELECTED(Date[Date]), Date[Date] <= MAX(Date[Date])))');
    expect(w('sales % of total')).toMatchObject({ expression: 'DIVIDE([Total Sales], CALCULATE([Total Sales], ALLSELECTED()))', format: '0.0%' });
  });

  it('adds filters from values in the request, and validates by evaluating', () => {
    const r = w('sales for bikes in 2025');
    expect(r.expression).toMatch(/^CALCULATE\(\[Total Sales\], .*Product\[Category\] = "Bikes"/);
    expect(r.expression).toContain('Date[Year] = 2025');
    expect(r.name).toMatch(/^Total Sales \(.*Bikes.*\)$/);
    expect(typeof r.value).toBe('number');
    expect(r.value as number).toBeLessThan(model.evaluate('[Total Sales]') as number);
  });

  it('writes ratios and margins', () => {
    expect(w('profit per order')).toMatchObject({ expression: 'DIVIDE([Total Profit], [Orders])', name: 'Total Profit per Orders' });
    expect(w('profit margin')).toMatchObject({ expression: 'DIVIDE([Total Profit], [Total Sales])', format: '0.0%', name: 'Total Profit Margin' });
    expect(w('average quantity').expression).toBe('AVERAGE(Sales[Quantity])');
  });

  it('explains what it could not understand', () => {
    expect(() => w('')).toThrow(/Describe/);
    expect(() => w('happiness of the moon')).toThrow(/Couldn't find a measure/);
  });
});

describe('writeDax with an LLM', () => {
  it('validates, retries with the error, and falls back to rules', async () => {
    const prompts: string[] = [];
    const bad = async (p: string) => (prompts.push(p), '```json\n{"expression": "SUM(Nope[x])", "name": "Bad"}\n```');
    const r = await writeDax(model, 'sales year to date', { llm: bad });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/previous answer failed/);
    expect(r.source).toBe('rules');
    expect(r.note).toMatch(/language model's answer failed/);
    const good = await writeDax(model, 'anything', { llm: async () => '{"expression": "[Total Sales] * 2", "name": "Double", "format": "$#,0"}' });
    expect(good).toMatchObject({ expression: '[Total Sales] * 2', name: 'Double', format: '$#,0', source: 'llm' });
  });
});

describe('explainDax', () => {
  it('explains expressions and the measures they use', () => {
    expect(explainDax(model, 'CALCULATE([Total Sales], SAMEPERIODLASTYEAR(Date[Date]))')).toBe(
      'Calculates [Total Sales], for the same period last year.\n[Total Sales] is the sum of Sales[SalesAmount].',
    );
    expect(explainDax(model, 'DIVIDE([Total Profit], [Total Sales])').split('\n')[0]).toBe('Calculates [Total Profit] divided by [Total Sales] (blank when that is zero).');
    expect(explainDax(model, 'SUMX(Sales, Sales[Quantity] * Sales[UnitPrice])')).toBe('Calculates the sum of Sales[Quantity] times Sales[UnitPrice] for each row of Sales.');
    expect(explainDax(model, 'CALCULATE([Orders], ALL(Product), Product[Color] = "Red")').split('\n')[0]).toBe('Calculates [Orders], ignoring filters on Product and where Product[Color] is "Red".');
    expect(explainDax(model, 'DIVIDE([Total Sales] - [Sales LY], [Sales LY])').split('\n')[0]).toBe('Calculates ([Total Sales] minus [Sales LY]) divided by [Sales LY] (blank when that is zero).');
    expect(explainDax(model, '([Total Sales] - [Sales LY]) / [Sales LY]').split('\n')[0]).toBe('Calculates ([Total Sales] minus [Sales LY]) divided by [Sales LY].');
    expect(() => explainDax(model, 'SUM(')).toThrow();
  });
});

describe('Studio measure editor copilot', () => {
  it('writes DAX into the dialog, explains it, and saves a validated measure', async () => {
    const el = document.createElement('div');
    el.style.height = '700px';
    document.body.append(el);
    const m = buildModel();
    const studio = new Studio(el, { model: m, starter: 'blank', copilot: daxCopilot(m) });
    studio.editMeasure();
    const dialog = el.querySelector('[role="dialog"]')!;
    const ask = dialog.querySelector<HTMLInputElement>('input[aria-label="Describe the measure"]')!;
    ask.value = 'sales year to date';
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === '✦ Write DAX')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(dialog.querySelector('textarea')!.value).toBe('TOTALYTD([Total Sales], Date[Date])');
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Measure name"]')!.value).toBe('Total Sales YTD');
    expect(dialog.querySelector('.pbs-preview')!.textContent).toMatch(/Value with no filters/);
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Explain')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(dialog.querySelector('.pbs-copilot-note')!.textContent).toMatch(/^Calculates \[Total Sales\] year to date/);
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Create')!.click();
    expect(m.hasMeasure('Total Sales YTD')).toBe(true);
    studio.destroy();
    el.remove();
  });
});
