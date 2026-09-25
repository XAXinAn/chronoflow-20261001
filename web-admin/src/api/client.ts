import type { ApiEnvelope } from './types';

/**
 * 后端统一响应体为 `{code, message, data, traceId}`：
 * 业务可预期错误也返回 HTTP 200，语义由 `code` 表达（spec §6.1）。
 * 因此这里必须同时看 HTTP 状态与业务码。
 */
export class ApiError extends Error {
  readonly code: number;
  readonly traceId?: string;

  constructor(code: number, message: string, traceId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.traceId = traceId;
  }

  /** 未登录 / 令牌过期，需要跳转登录页 */
  get isUnauthenticated(): boolean {
    return this.code === 20001 || this.code === 20002;
  }

  /** 已登录但无权限，不应清空会话 */
  get isForbidden(): boolean {
    return this.code === 20003;
  }
}

export interface ClientOptions {
  baseUrl?: string;
  getToken?: () => string | null;
  onUnauthenticated?: () => void;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'http://localhost:8080';

export function resolveBaseUrl(explicit?: string): string {
  const configured = explicit ?? import.meta.env.VITE_API_BASE_URL ?? DEFAULT_BASE_URL;
  return configured.replace(/\/+$/, '');
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  formData?: FormData;
}

export function createClient(options: ClientOptions = {}) {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  function buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  function authHeaders(accept: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: accept };
    const token = options.getToken?.() ?? null;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async function request<T>(path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const headers = authHeaders('application/json');
    let body: BodyInit | undefined;
    if (requestOptions.formData) {
      body = requestOptions.formData;
    } else if (requestOptions.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(requestOptions.body);
    }

    const response = await fetchImpl(buildUrl(path, requestOptions.query), {
      method: requestOptions.method ?? 'GET',
      headers,
      body,
    });

    const raw = await response.text();
    let envelope: ApiEnvelope<T>;
    try {
      envelope = JSON.parse(raw) as ApiEnvelope<T>;
    } catch {
      throw new ApiError(-1, `响应不是合法 JSON（HTTP ${response.status}）`);
    }

    if (envelope.code !== 0) {
      const error = new ApiError(envelope.code, envelope.message ?? '请求失败', envelope.traceId);
      if (response.status === 401 || error.isUnauthenticated) {
        options.onUnauthenticated?.();
      }
      throw error;
    }
    return envelope.data;
  }

  /**
   * 导出类接口返回的是 CSV 而非统一响应体，需要绕过 JSON 解析。
   */
  async function getText(path: string, query?: RequestOptions['query']): Promise<string> {
    const response = await fetchImpl(buildUrl(path, query), {
      method: 'GET',
      headers: authHeaders('text/csv'),
    });
    if (!response.ok) {
      if (response.status === 401) {
        options.onUnauthenticated?.();
      }
      throw new ApiError(-1, `导出失败（HTTP ${response.status}）`);
    }
    return response.text();
  }

  return {
    baseUrl,
    get: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { query }),
    post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
    postForm: <T>(path: string, formData: FormData) => request<T>(path, { method: 'POST', formData }),
    patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
    put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
    del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
    getText,
    request,
  };
}

export type ApiClient = ReturnType<typeof createClient>;
