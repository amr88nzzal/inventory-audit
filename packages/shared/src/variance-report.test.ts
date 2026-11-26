import { describe, expect, it } from 'vitest';
import { buildVarianceReport } from './variance-report';

const base = { itemTolerances: {}, defaultTolerancePct: '0', aggregateLocations: true } as const;

describe('buildVarianceReport', () => {
  it('sums counts across locations and compares with the snapshot', () => {
    const { rows, summary } = buildVarianceReport({
      ...base,
      counted: [
        { itemId: 'a', locationId: 'L1', quantity: '10' },
        { itemId: 'a', locationId: 'L2', quantity: '5.5' },
      ],
      theoretical: [{ itemId: 'a', quantity: '20' }],
    });
    expect(rows).toEqual([
      {
        itemId: 'a',
        counted: '15.5',
        theoretical: '20',
        difference: '-4.5',
        differencePct: '-22.5',
        status: 'short',
        appliedTolerancePct: '0',
        flaggedForRecount: true,
      },
    ]);
    expect(summary).toMatchObject({ items: 1, short: 1, flagged: 1, totalDifference: '-4.5' });
  });

  it('is exact on decimals (0.1 + 0.2 = 0.3)', () => {
    const { rows } = buildVarianceReport({
      ...base,
      counted: [
        { itemId: 'a', locationId: null, quantity: '0.1' },
        { itemId: 'a', locationId: null, quantity: '0.2' },
      ],
      theoretical: [{ itemId: 'a', quantity: '0.3' }],
    });
    expect(rows[0]).toMatchObject({
      counted: '0.3',
      difference: '0',
      status: 'match',
      flaggedForRecount: false,
    });
  });

  it('uncounted snapshot items are full shortages; items outside the snapshot have theoretical 0', () => {
    const { rows, summary } = buildVarianceReport({
      ...base,
      counted: [{ itemId: 'x', locationId: null, quantity: '3' }],
      theoretical: [{ itemId: 'y', quantity: '8' }],
    });
    expect(rows.find((r) => r.itemId === 'y')).toMatchObject({
      counted: '0',
      difference: '-8',
      differencePct: '-100',
      status: 'short',
    });
    expect(rows.find((r) => r.itemId === 'x')).toMatchObject({
      theoretical: '0',
      difference: '3',
      differencePct: null,
      status: 'over',
      flaggedForRecount: true,
    });
    expect(summary).toMatchObject({ items: 2, over: 1, short: 1, flagged: 2 });
  });

  it('tolerance priority is item, then task, then default', () => {
    const run = (item: string | null, task: string | null, def: string) =>
      buildVarianceReport({
        counted: [{ itemId: 'a', locationId: null, quantity: '197' }], // -1.5%
        theoretical: [{ itemId: 'a', quantity: '200' }],
        itemTolerances: { a: item },
        taskTolerancePct: task,
        defaultTolerancePct: def,
        aggregateLocations: true,
      }).rows[0]!;
    expect(run('2', '0', '0')).toMatchObject({
      appliedTolerancePct: '2',
      flaggedForRecount: false,
    });
    expect(run(null, '1', '5')).toMatchObject({
      appliedTolerancePct: '1',
      flaggedForRecount: true,
    });
    expect(run(null, null, '5')).toMatchObject({
      appliedTolerancePct: '5',
      flaggedForRecount: false,
    });
    expect(run(null, null, '1.5')).toMatchObject({ flaggedForRecount: false }); // exactly at the limit
  });

  it('adds a per-location breakdown only when aggregation is off', () => {
    const input = {
      counted: [
        { itemId: 'a', locationId: 'L2', quantity: '1' },
        { itemId: 'a', locationId: 'L1', quantity: '2' },
        { itemId: 'a', locationId: 'L1', quantity: '3' },
      ],
      theoretical: [{ itemId: 'a', quantity: '6' }],
      itemTolerances: {},
      defaultTolerancePct: '0',
    };
    expect(buildVarianceReport({ ...input, aggregateLocations: true }).rows[0]).not.toHaveProperty(
      'locations',
    );
    expect(buildVarianceReport({ ...input, aggregateLocations: false }).rows[0]!.locations).toEqual(
      [
        { locationId: 'L1', counted: '5' },
        { locationId: 'L2', counted: '1' },
      ],
    );
  });

  it('empty input yields empty results', () => {
    expect(buildVarianceReport({ ...base, counted: [], theoretical: [] })).toMatchObject({
      rows: [],
      summary: { items: 0, totalCounted: '0', totalDifference: '0' },
    });
  });
});
