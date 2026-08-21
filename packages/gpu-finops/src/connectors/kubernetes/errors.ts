import type { GpuSourceSystem } from '../../interfaces/index.js';

export class KubernetesConnectorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly sourceSystem: GpuSourceSystem = 'kubernetes';
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, retryable: boolean, details?: Record<string, unknown>) {
    super(message);
    this.name = 'KubernetesConnectorError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function toKubernetesConnectorError(error: unknown) {
  if (error instanceof KubernetesConnectorError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      sourceSystem: error.sourceSystem,
      details: error.details,
    };
  }
  return {
    code: 'kubernetes_api_error',
    message: error instanceof Error ? error.message : 'Kubernetes API request failed.',
    retryable: false,
    sourceSystem: 'kubernetes' as const,
  };
}
