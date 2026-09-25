import type { SessionManager } from '../auth/session';
import type { ApiEnvelope } from './types';

export class ApiError extends Error {
  readonly code: number;
  readonly traceId?: string;

  constructor(code: number, message: string, traceId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.traceId = traceId;
  }

  get isUnauthenticated(): boolean {
    return this.code === 20001 || this.code === 20002;
  }

  get isForbidden(): boolean {
    return this.code === 20003;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  session?: SessionManager;
  fetchImpl?: typeof fetch;
  /** 刷新也失败时回调，用于跳转登录页 */
  onSessionExpired?: () => void;
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** 登录、刷新等接口不应触发「刷新后重放」 */
  skipAuthRetry?: boolean;
  /** 覆盖请求头，例如用 registerToken 调创建身份接口 */
  headers?: Record<string, string>;
}

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  function buildUrl(path: string, query?: ApiRequestOptions['query']): string {
    const url = new URL(baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async function send(path: string, requestOptions: ApiRequestOptions): Promise<ApiEnvelope<unknown>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...requestOptions.headers,
    };
    if (!headers.Authorization) {
      // getAccessToken 在令牌临近过期时会自行刷新；刷新失败必须在这里兜住，
      // 否则 SessionExpiredError 会绕过 request() 的重试与错误处理，用户看到原始异常。
      try {
        const token = await options.session?.getAccessToken();
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
      } catch {
        options.onSessionExpired?.();
        throw new ApiError(20002, '登录已过期，请重新登录');
      }
    }
    const response = await fetchImpl(buildUrl(path, requestOptions.query), {
      method: requestOptions.method ?? 'GET',
      headers,
      body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
    });
    const text = await response.text();
    try {
      return JSON.parse(text) as ApiEnvelope<unknown>;
    } catch {
      throw new ApiError(-1, `响应不是合法 JSON（HTTP ${response.status}）`);
    }
  }

  async function request<T>(path: string, requestOptions: ApiRequestOptions = {}): Promise<T> {
    let envelope = await send(path, requestOptions);

    // 访问令牌失效 → 静默刷新一次 → 重放原请求，用户无感知（spec §3.7.2）
    const unauthenticated = envelope.code === 20001 || envelope.code === 20002;
    if (unauthenticated && !requestOptions.skipAuthRetry && options.session) {
      try {
        await options.session.forceRefresh();
      } catch {
        options.onSessionExpired?.();
        throw new ApiError(envelope.code, envelope.message, envelope.traceId);
      }
      envelope = await send(path, requestOptions);
    }

    if (envelope.code !== 0) {
      const error = new ApiError(envelope.code, envelope.message || '请求失败', envelope.traceId);
      if (error.isUnauthenticated && !requestOptions.skipAuthRetry) {
        options.onSessionExpired?.();
      }
      throw error;
    }
    return envelope.data as T;
  }

  return {
    baseUrl,
    request,
    get: <T>(path: string, query?: ApiRequestOptions['query']) => request<T>(path, { query }),
    post: <T>(path: string, body?: unknown, extra: ApiRequestOptions = {}) =>
      request<T>(path, { ...extra, method: 'POST', body }),
    patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
    del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
