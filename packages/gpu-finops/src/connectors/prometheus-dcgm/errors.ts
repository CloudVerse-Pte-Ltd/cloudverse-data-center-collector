import type { GpuSourceSystem } from '../../interfaces/index.js';

export class PrometheusDcgmConnectorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly sourceSystem: GpuSourceSystem = 'dcgm';
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, retryable: boolean, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PrometheusDcgmConnectorError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function toConnectorError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  sourceSystem: GpuSourceSystem;
  details?: Record<string, unknown>;
} {
  if (error instanceof PrometheusDcgmConnectorError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      sourceSystem: error.sourceSystem,
      details: error.details,
    };
  }

  return {
    code: 'prometheus_query_failed',
    message: error instanceof Error ? error.message : 'Prometheus query failed.',
    retryable: false,
    sourceSystem: 'dcgm',
  };
}
