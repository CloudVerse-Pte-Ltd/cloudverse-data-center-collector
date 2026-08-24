import type { GpuDeploymentMode, GpuProvider } from '../../interfaces/index.js';

export interface PrometheusDcgmTlsConfig {
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  rejectUnauthorized?: boolean;
  serverName?: string;
}

export interface PrometheusDcgmProxyConfig {
  url?: string;
  noProxy?: string[];
}

export interface PrometheusDcgmBasicAuthConfig {
  username: string;
  password: string;
}

export interface PrometheusDcgmAuthConfig {
  bearerToken?: string;
  bearerTokenFile?: string;
  basic?: PrometheusDcgmBasicAuthConfig;
}

export interface PrometheusDcgmConnectorConfig {
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
  auth?: PrometheusDcgmAuthConfig;
  tls?: PrometheusDcgmTlsConfig;
  proxy?: PrometheusDcgmProxyConfig;
  staleAfterSeconds?: number;
}

export interface PrometheusDcgmCollectionContext {
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  connectorId: string;
  connectorVersion: string;
  clusterId?: string;
  collectedAt: string;
}

export interface PrometheusDcgmInstantCollectionRequest {
  mode: 'instant';
  time?: string;
  queryNames?: string[];
}

export interface PrometheusDcgmRangeCollectionRequest {
  mode: 'range';
  start: string;
  end: string;
  step: string;
  queryNames?: string[];
}

export type PrometheusDcgmCollectionRequest =
  | PrometheusDcgmInstantCollectionRequest
  | PrometheusDcgmRangeCollectionRequest;

export interface PrometheusDcgmConfigValidationResult {
  valid: boolean;
  findings: Array<{
    code: string;
    message: string;
    severity: 'INFO' | 'WARNING' | 'ERROR';
  }>;
}

export function validatePrometheusDcgmConfig(
  config: PrometheusDcgmConnectorConfig,
): PrometheusDcgmConfigValidationResult {
  const findings: PrometheusDcgmConfigValidationResult['findings'] = [];

  try {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      findings.push({
        code: 'invalid_base_url',
        severity: 'ERROR',
        message: 'Prometheus baseUrl must use http or https.',
      });
    }
    if (url.username || url.password) {
      findings.push({
        code: 'connector_auth_config_invalid',
        severity: 'ERROR',
        message: 'Do not include credentials in the Prometheus baseUrl. Use auth config instead.',
      });
    }
  } catch {
    findings.push({
      code: 'invalid_base_url',
      severity: 'ERROR',
      message: 'Prometheus baseUrl must be a valid URL.',
    });
  }

  const configuredAuthMethods = [config.auth?.bearerToken, config.auth?.bearerTokenFile, config.auth?.basic]
    .filter(Boolean).length;
  if (configuredAuthMethods > 1) {
    findings.push({
      code: 'connector_auth_config_invalid',
      severity: 'ERROR',
      message: 'Configure exactly one of bearer token, bearer token file, or basic auth.',
    });
  }

  if (config.tls?.rejectUnauthorized === false) {
    findings.push({
      code: 'connector_tls_config_warning',
      severity: 'WARNING',
      message: 'TLS certificate verification is disabled. This is not recommended for production.',
    });
  }

  if (config.timeoutMs !== undefined && config.timeoutMs <= 0) {
    findings.push({
      code: 'invalid_timeout',
      severity: 'ERROR',
      message: 'timeoutMs must be greater than zero.',
    });
  }

  if (config.maxRetries !== undefined && (config.maxRetries < 0 || config.maxRetries > 5)) {
    findings.push({
      code: 'invalid_retry_count',
      severity: 'ERROR',
      message: 'maxRetries must be between 0 and 5.',
    });
  }

  return {
    valid: findings.every((finding) => finding.severity !== 'ERROR'),
    findings,
  };
}

export function sanitizedPrometheusBaseUrlHost(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.host;
}
