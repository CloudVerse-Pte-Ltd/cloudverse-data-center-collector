import type { GpuSourceSystem } from '../../interfaces/index.js';

export class VCenterConnectorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly sourceSystem: GpuSourceSystem = 'vcenter';
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, retryable: boolean, details?: Record<string, unknown>) {
    super(message);
    this.name = 'VCenterConnectorError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function toVCenterConnectorError(error: unknown) {
  if (error instanceof VCenterConnectorError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      sourceSystem: error.sourceSystem,
      details: error.details,
    };
  }

  return {
    code: 'vcenter_query_failed',
    message: error instanceof Error ? error.message : 'vCenter query failed.',
    retryable: false,
    sourceSystem: 'vcenter' as const,
  };
}
