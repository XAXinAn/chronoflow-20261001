import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, createClient, resolveBaseUrl } from '../src/api/client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api client', () => {
  it('业务码为 0 时返回 data，并透传鉴权头', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
      return jsonResponse({ code: 0, message: 'ok', data: { hello: 'world' }, traceId: 't-1' });
    });

    const client = createClient({
      baseUrl: 'http://api.test',
      getToken: () => 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.get<{ hello: string }>('/api/v1/ping')).resolves.toEqual({ hello: 'world' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('业务码非 0 时抛 ApiError，并保留错误码与 traceId', async () => {
    const client = createClient({
      baseUrl: 'http://api.test',
      fetchImpl: (async () =>
        jsonResponse({ code: 20003, message: '无权限', data: null, traceId: 't-2' })) as unknown as typeof fetch,
    });

    const error = await client.get('/api/v1/admin/organizations').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(20003);
    expect((error as ApiError).traceId).toBe('t-2');
    expect((error as ApiError).isForbidden).toBe(true);
    expect((error as ApiError).isUnauthenticated).toBe(false);
  });

  it('未登录时触发 onUnauthenticated 回调（HTTP 401 即便业务码为 0 之外的形态也算）', async () => {
    const onUnauthenticated = vi.fn();
    const client = createClient({
      baseUrl: 'http://api.test',
      onUnauthenticated,
      fetchImpl: (async () =>
        jsonResponse({ code: 20001, message: '未登录', data: null }, 401)) as unknown as typeof fetch,
    });

    await expect(client.get('/api/v1/admin/me')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });

  it('无权限（20003）不应清空会话', async () => {
    const onUnauthenticated = vi.fn();
    const client = createClient({
      baseUrl: 'http://api.test',
      onUnauthenticated,
      fetchImpl: (async () =>
        jsonResponse({ code: 20003, message: '无权限', data: null }, 403)) as unknown as typeof fetch,
    });

    await expect(client.get('/api/v1/admin/me')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it('查询参数会拼接进 URL，空值被忽略', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('phone=138');
      expect(url).not.toContain('status=');
      return jsonResponse({ code: 0, message: 'ok', data: [] });
    });

    const client = createClient({
      baseUrl: 'http://api.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.get('/api/v1/admin/accounts', { phone: '138', status: undefined, limit: 20 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('导出接口返回 CSV 文本而非统一响应体', async () => {
    const client = createClient({
      baseUrl: 'http://api.test',
      getToken: () => 'token-1',
      fetchImpl: (async () =>
        new Response('时间,操作人\n2026-01-01,admin\n', {
          status: 200,
          headers: { 'Content-Type': 'text/csv;charset=UTF-8' },
        })) as unknown as typeof fetch,
    });

    await expect(client.getText('/api/v1/admin/audit-logs/export')).resolves.toContain('操作人');
  });

  it('响应体不是 JSON 时给出可读错误，而不是抛出解析异常', async () => {
    const client = createClient({
      baseUrl: 'http://api.test',
      fetchImpl: (async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch,
    });

    const error = await client.get('/api/v1/ping').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('502');
  });

  it('baseUrl 会去掉结尾斜杠', () => {
    expect(resolveBaseUrl('http://api.test/')).toBe('http://api.test');
  });
});
