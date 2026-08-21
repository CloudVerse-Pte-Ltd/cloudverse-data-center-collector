export type CollectorScaleClass = 'S' | 'M' | 'L' | 'XL';

const GIB = 1_073_741_824;
export const COLLECTOR_SPOOL_BUDGET_BYTES: Readonly<Record<CollectorScaleClass, number>> = Object.freeze({
  S: 10 * GIB,
  M: 50 * GIB,
  L: 200 * GIB,
  XL: 500 * GIB,
});

export function collectorSpoolBudget(environment: NodeJS.ProcessEnv = process.env) {
  const scaleClass = String(environment.COLLECTOR_SCALE_CLASS ?? '').trim().toUpperCase() as CollectorScaleClass;
  const ceiling = COLLECTOR_SPOOL_BUDGET_BYTES[scaleClass];
  if (!ceiling) throw new Error('COLLECTOR_SCALE_CLASS must be S, M, L or XL');
  const configured = Number(environment.COLLECTOR_SPOOL_MAX_BYTES ?? ceiling);
  if (!Number.isSafeInteger(configured) || configured <= 0) throw new Error('COLLECTOR_SPOOL_MAX_BYTES must be a positive integer');
  if (configured > ceiling) throw new Error(`COLLECTOR_SPOOL_MAX_BYTES exceeds the ratified ${scaleClass} scale-class ceiling`);
  return { scaleClass, maxBytes: configured, ceiling };
}
