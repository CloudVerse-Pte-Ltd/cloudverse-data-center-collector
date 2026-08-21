import type { GpuDeploymentMode, GpuProvider } from '../../interfaces/index.js';

export interface VCenterAuthConfig {
  bearerToken?: string;
  basic?: {
    username: string;
    password: string;
  };
}

export interface VCenterConnectorConfig {
  baseUrl?: string;
  /** Required for session-token-only discovery; basic auth reads about.instanceUuid over SOAP. */
  managementPlaneUid?: string;
  inventoryPath?: string;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
  auth?: VCenterAuthConfig;
}

export interface VCenterCollectionContext {
  tenantId: string;
  orgId: string;
  deploymentMode: GpuDeploymentMode;
  provider: GpuProvider;
  connectorId: string;
  connectorVersion: string;
  clusterId?: string;
  collectedAt: string;
}

export interface VCenterValidationFinding {
  code: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  message: string;
}

export function validateVCenterConnectorConfig(config: VCenterConnectorConfig): {
  valid: boolean;
  findings: VCenterValidationFinding[];
} {
  const findings: VCenterValidationFinding[] = [];

  if (config.baseUrl) {
    try {
      const url = new URL(config.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        findings.push({ code: 'invalid_base_url', severity: 'ERROR', message: 'vCenter baseUrl must use http or https.' });
      }
      if (url.username || url.password) {
        findings.push({
          code: 'connector_auth_config_invalid',
          severity: 'ERROR',
          message: 'Do not include credentials in vCenter baseUrl. Use auth config instead.',
        });
      }
    } catch {
      findings.push({ code: 'invalid_base_url', severity: 'ERROR', message: 'vCenter baseUrl must be a valid URL.' });
    }
  }

  if (config.auth?.bearerToken && config.auth.basic) {
    findings.push({ code: 'connector_auth_config_invalid', severity: 'ERROR', message: 'Use either bearer token or basic auth, not both.' });
  }
  if (config.managementPlaneUid !== undefined && !/^vcenter:[0-9a-f-]{36}$/i.test(config.managementPlaneUid)) {
    findings.push({
      code: 'invalid_management_plane_uid',
      severity: 'ERROR',
      message: 'managementPlaneUid must be vcenter:<ServiceInstance about.instanceUuid>.',
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
