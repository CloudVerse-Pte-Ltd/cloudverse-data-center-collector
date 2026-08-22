import { describe, expect, it } from 'vitest';
import { COLLECTOR_SOURCE_CONCURRENCY, collectorSpoolBudget } from '../../src/on-prem-collector/scale-budget.js';

describe('P0-D12 collector scale budget', () => {
  it.each([
    ['S', 4], ['M', 8], ['L', 12], ['XL', 16],
  ] as const)('binds %s to its ratified source-request ceiling', (scaleClass, sourceConcurrency) => {
    expect(collectorSpoolBudget({ COLLECTOR_SCALE_CLASS: scaleClass })).toMatchObject({ scaleClass, sourceConcurrency });
    expect(COLLECTOR_SOURCE_CONCURRENCY[scaleClass]).toBe(sourceConcurrency);
  });
});
