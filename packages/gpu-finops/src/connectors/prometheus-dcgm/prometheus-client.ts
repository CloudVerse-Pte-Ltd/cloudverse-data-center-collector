import {
  type PrometheusDcgmConnectorConfig,
  validatePrometheusDcgmConfig,
} from './config.js';
import { PrometheusDcgmConnectorError } from './errors.js';

export interface PrometheusApiSample {
  metric: Record<string, string>;
  value?: [number, string];
  values?: Array<[number, string]>;
}

export interface PrometheusApiResponse {
  status: 'success' | 'error';
  data?: {
    resultType: 'vector' | 'matrix' | string;
    result: PrometheusApiSample[];
  };
  errorType?: string;
  error?: string;
  warnings?: string[];
  infos?: string[];
}

export interface PrometheusQueryOptions {
  query: string;
  time?: string;
  timeout?: string;
}

export interface PrometheusRangeQueryOptions {
  query: string;
  start: string;
  end: string;
  step: string;
  timeout?: string;
}

export interface PrometheusDcgmClient {
  query(options: PrometheusQueryOptions): Promise<PrometheusApiResponse>;
  queryRange(options: PrometheusRangeQueryOptions): Promise<PrometheusApiResponse>;
}

export interface PrometheusDcgmClientOptions {
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

function authHeaders(config: PrometheusDcgmConnectorConfig): Record<string, string> {
  if (config.auth?.bearerToken) {
    return { Authorization: `Bearer ${config.auth.bearerToken}` };
  }
  if (config.auth?.basic) {
    const encoded = Buffer.from(`${config.auth.basic.username}:${config.auth.basic.password}`, 'utf8').toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
  return {};
}

function requestHeaders(config: PrometheusDcgmConnectorConfig): Headers {
  return new Headers({
    Accept: 'application/json',
    ...(config.headers ?? {}),
    ...authHeaders(config),
  });
}

function withQuery(url: URL, params: Record<string, string | undefined>): URL {
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function createPrometheusDcgmClient(
  config: PrometheusDcgmConnectorConfig,
  options: PrometheusDcgmClientOptions = {},
): PrometheusDcgmClient {
  const validation = validatePrometheusDcgmConfig(config);
  if (!validation.valid) {
    throw new PrometheusDcgmConnectorError(
      'invalid_prometheus_config',
      'Prometheus/DCGM connector config is invalid.',
      false,
      { findings: validation.findings },
    );
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new PrometheusDcgmConnectorError('fetch_unavailable', 'Global fetch is unavailable in this Node runtime.', false);
  }

  const maxRetries = config.maxRetries ?? 1;
  const timeoutMs = config.timeoutMs ?? 10_000;

  async function request(path: string, params: Record<string, string | undefined>): Promise<PrometheusApiResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const url = withQuery(appendPath(config.baseUrl, path), params);

      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: requestHeaders(config),
          signal: controller.signal,
        });

        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          if (retryable && attempt < maxRetries) {
            continue;
          }
          throw new PrometheusDcgmConnectorError('prometheus_query_failed', `Prometheus query failed with HTTP ${response.status}.`, retryable, {
            status: response.status,
          });
        }

        const body = (await response.json()) as PrometheusApiResponse;
        if (body.status === 'error') {
          throw new PrometheusDcgmConnectorError('prometheus_query_failed', body.error ?? 'Prometheus returned an error response.', false, {
            errorType: body.errorType,
          });
        }
        return body;
      } catch (error) {
        lastError = error;
        if (error instanceof DOMException && error.name === 'AbortError') {
          if (attempt < maxRetries) {
            continue;
          }
          throw new PrometheusDcgmConnectorError('prometheus_query_timeout', 'Prometheus query timed out.', true, {
            timeoutMs,
          });
        }
        if (error instanceof PrometheusDcgmConnectorError && error.retryable && attempt < maxRetries) {
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
      : new PrometheusDcgmConnectorError('prometheus_query_failed', 'Prometheus query failed.', false);
  }

  return {
    query(options: PrometheusQueryOptions) {
      return request('/api/v1/query', {
        query: options.query,
        time: options.time,
        timeout: options.timeout,
      });
    },
    queryRange(options: PrometheusRangeQueryOptions) {
      return request('/api/v1/query_range', {
        query: options.query,
        start: options.start,
        end: options.end,
        step: options.step,
        timeout: options.timeout,
      });
    },
  };
}
