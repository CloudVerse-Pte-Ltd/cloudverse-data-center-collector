import type { GpuDeploymentMode, GpuProvider } from '../../interfaces/index.js';

export type KubernetesPlatformHint = 'KUBERNETES' | 'OPENSHIFT' | 'UNKNOWN';

export interface KubernetesTlsConfig {
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  rejectUnauthorized?: boolean;
  serverName?: string;
}

export interface KubernetesAuthConfig {
  bearerToken?: string;
  serviceAccountTokenFile?: string;
}

export interface KubernetesConnectorConfig {
  baseUrl: string;
  platformHint?: KubernetesPlatformHint;
  auth?: KubernetesAuthConfig;
  tls?: KubernetesTlsConfig;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface KubernetesCollectionContext {
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  connectorId: string;
  connectorVersion: string;
  clusterId: string;
  clusterName: string;
  collectedAt: string;
}

export interface KubernetesConfigValidationFinding {
  code: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  message: string;
}

export function validateKubernetesConnectorConfig(config: KubernetesConnectorConfig): {
  valid: boolean;
  findings: KubernetesConfigValidationFinding[];
} {
  const findings: KubernetesConfigValidationFinding[] = [];

  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      findings.push({ code: 'invalid_base_url', severity: 'ERROR', message: 'Kubernetes baseUrl must use http or https.' });
    }
    if (url.username || url.password) {
      findings.push({
        code: 'connector_auth_config_invalid',
        severity: 'ERROR',
        message: 'Do not put credentials in the Kubernetes baseUrl. Use auth config instead.',
      });
    }
  } catch {
    findings.push({ code: 'invalid_base_url', severity: 'ERROR', message: 'Kubernetes baseUrl must be a valid URL.' });
  }

  if (config.tls?.rejectUnauthorized === false) {
    findings.push({
      code: 'connector_tls_config_warning',
      severity: 'WARNING',
      message: 'TLS verification is disabled. This is not recommended for production.',
    });
  }

  if (config.timeoutMs !== undefined && config.timeoutMs <= 0) {
    findings.push({ code: 'invalid_timeout', severity: 'ERROR', message: 'timeoutMs must be greater than zero.' });
  }

  if (config.maxRetries !== undefined && (config.maxRetries < 0 || config.maxRetries > 5)) {
    findings.push({ code: 'invalid_retry_count', severity: 'ERROR', message: 'maxRetries must be between 0 and 5.' });
  }

  return { valid: findings.every((finding) => finding.severity !== 'ERROR'), findings };
}

export function sanitizedKubernetesBaseUrlHost(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.host;
}
