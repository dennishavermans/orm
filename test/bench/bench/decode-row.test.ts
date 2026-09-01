import { describe, expect, it } from 'vitest';
import rowsJson from '../fixtures/rows.json' with { type: 'json' };
import {
  benchmarkCases,
  benchmarkWorkload,
  createWeightedWorkload,
  decodeResultSet,
} from './decode-row';

describe('decode row benchmark', () => {
  it('matches every benchmark plan to fixture rows', () => {
    expect(benchmarkCases.map(({ name }) => name).sort()).toEqual(Object.keys(rowsJson).sort());
  });

  it('decodes a representative result set', async () => {
    const benchmarkCase = benchmarkCases.find(({ name }) => name === 'customerById');
    if (!benchmarkCase) {
      throw new Error('Missing customerById benchmark case');
    }

    await expect(decodeResultSet(benchmarkCase.rows, benchmarkCase.decodeCtx)).resolves.toEqual([
      {
        id: 4211,
        company_name: 'Hudson, Turner and Prohaska',
        contact_name: 'Manuel Langworth',
        contact_title: 'Regional Identity Associate',
        address: '2537 Earl Curve',
        city: 'Farrellburgh',
        postal_code: null,
        region: 'Vermont',
        country: 'South Sudan',
        phone: '(844) 856-4750',
        fax: '(984) 206-3201',
      },
    ]);
  });

  it('constructs a workload using the configured weights', () => {
    const cases = [{ name: 'frequent' }, { name: 'occasional' }];

    expect(
      createWeightedWorkload(cases, { frequent: 3, occasional: 1 }, 8).map(({ name }) => name),
    ).toEqual([
      'frequent',
      'frequent',
      'frequent',
      'frequent',
      'frequent',
      'frequent',
      'occasional',
      'occasional',
    ]);
  });

  it('pins the original mixed benchmark workload', () => {
    expect(benchmarkWorkload.map(({ name }) => name)).toEqual([
      ...Array<string>(47).fill('orderWithDetails'),
      ...Array<string>(47).fill('orderWithDetailsAndProducts'),
      ...Array<string>(47).fill('productWithSupplier'),
      ...Array<string>(23).fill('searchProduct'),
      ...Array<string>(14).fill('supplierById'),
      ...Array<string>(9).fill('customerById'),
      ...Array<string>(5).fill('ordersWithDetails'),
      ...Array<string>(2).fill('searchCustomer'),
      ...Array<string>(2).fill('employeeWithRecipient'),
      'products',
      'customers',
    ]);
    expect(benchmarkWorkload).toHaveLength(198);
    expect(benchmarkWorkload.reduce((rows, entry) => rows + entry.rows.length, 0)).toBe(1047);
  });
});
