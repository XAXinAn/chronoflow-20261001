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

/**
 * 默认 API 地址：**生产用同源**，开发用本机后端。
 *
 * <p>踩过的坑（2026-10-02）：这里原来写死 `http://localhost:8080`，而管理端是**浏览器**在跑——
 * 部署到服务器后，浏览器会去请求**用户自己电脑的 8080**，于是「超管账号无法登录」，
 * 后端日志里连一条登录请求都没有。
 *
 * <p>生产为什么可以直接同源：web 容器的 nginx 已经反代了 `/api`、`/uploads`、`/map`，
 * 静态页面和接口同源，既没有跨域问题也不怕换域名。
 */
const DEFAULT_BASE_URL = import.meta.env.DEV ? 'http://localhost:8080' : '';

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
    /*
     * 同源时 `baseUrl` 是空串 —— 这时**不能**写 `new URL(path)`：相对地址没有 base 会直接抛
     * `TypeError: Invalid URL`，请求根本发不出去（2026-10-02 踩过：后台点了登录什么都不发生，
     * 服务端日志里一条请求都没有）。所以空串时补上当前页面的 origin。
     */
    const url = new URL(baseUrl + path, baseUrl || globalThis.location?.origin || 'http://localhost');
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

  /**
   * 下载二进制（xlsx 导入模板）。同样绕过统一响应体——
   * 模板是文件流，不是 `{code, message, data}`。
   */
  async function getBlob(path: string): Promise<Blob> {
    const response = await fetchImpl(buildUrl(path), {
      method: 'GET',
      headers: authHeaders('application/octet-stream'),
    });
    if (!response.ok) {
      if (response.status === 401) {
        options.onUnauthenticated?.();
      }
      throw new ApiError(-1, `下载失败（HTTP ${response.status}）`);
    }
    return response.blob();
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
    getBlob,
    request,
  };
}

export type ApiClient = ReturnType<typeof createClient>;
