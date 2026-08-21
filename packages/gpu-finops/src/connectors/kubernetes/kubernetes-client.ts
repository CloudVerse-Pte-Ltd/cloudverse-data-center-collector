import { readFile } from 'node:fs/promises';
import { type KubernetesConnectorConfig, validateKubernetesConnectorConfig } from './config.js';
import { KubernetesConnectorError } from './errors.js';

export interface KubernetesObjectList<T> {
  kind?: string;
  apiVersion?: string;
  items: T[];
}

export interface KubernetesInventoryClient {
  listNodes(): Promise<KubernetesObjectList<unknown>>;
  listNamespaces(): Promise<KubernetesObjectList<unknown>>;
  listPods(): Promise<KubernetesObjectList<unknown>>;
  listDeployments(): Promise<KubernetesObjectList<unknown>>;
  listJobs(): Promise<KubernetesObjectList<unknown>>;
}

export interface KubernetesInventoryClientOptions {
  fetchImpl?: typeof fetch;
}

function appendPath(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const normalizedBase = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  base.pathname = `${normalizedBase}${path}`;
  base.search = '';
  base.hash = '';
  base.username = '';
  base.password = '';
  return base;
}

async function authHeaders(config: KubernetesConnectorConfig): Promise<Record<string, string>> {
  const token = config.auth?.bearerToken ?? (config.auth?.serviceAccountTokenFile ? await readFile(config.auth.serviceAccountTokenFile, 'utf8') : undefined);
  return token ? { Authorization: `Bearer ${token.trim()}` } : {};
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function createKubernetesInventoryClient(
  config: KubernetesConnectorConfig,
  options: KubernetesInventoryClientOptions = {},
): KubernetesInventoryClient {
  const validation = validateKubernetesConnectorConfig(config);
  if (!validation.valid) {
    throw new KubernetesConnectorError('invalid_kubernetes_config', 'Kubernetes connector config is invalid.', false, {
      findings: validation.findings,
    });
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new KubernetesConnectorError('fetch_unavailable', 'Global fetch is unavailable in this Node runtime.', false);
  }

  const timeoutMs = config.timeoutMs ?? 10_000;
  const maxRetries = config.maxRetries ?? 1;

  async function request(path: string): Promise<KubernetesObjectList<unknown>> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(appendPath(config.baseUrl, path), {
          method: 'GET',
          headers: new Headers({
            Accept: 'application/json',
            ...(config.headers ?? {}),
            ...(await authHeaders(config)),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          if (retryable && attempt < maxRetries) {
            continue;
          }
          throw new KubernetesConnectorError('kubernetes_api_error', `Kubernetes API returned HTTP ${response.status}.`, retryable, {
            status: response.status,
            path,
          });
        }

        return (await response.json()) as KubernetesObjectList<unknown>;
      } catch (error) {
        lastError = error;
        if (error instanceof DOMException && error.name === 'AbortError') {
          if (attempt < maxRetries) {
            continue;
          }
          throw new KubernetesConnectorError('kubernetes_request_timeout', 'Kubernetes API request timed out.', true, {
            timeoutMs,
            path,
          });
        }
        if (error instanceof KubernetesConnectorError && error.retryable && attempt < maxRetries) {
          continue;
        }
        if (attempt >= maxRetries) {
          throw error;
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new KubernetesConnectorError('kubernetes_api_error', 'Kubernetes API request failed.', false, { path });
  }

  return {
    listNodes: () => request('/api/v1/nodes'),
    listNamespaces: () => request('/api/v1/namespaces'),
    listPods: () => request('/api/v1/pods'),
    listDeployments: () => request('/apis/apps/v1/deployments'),
    listJobs: () => request('/apis/batch/v1/jobs'),
  };
}
