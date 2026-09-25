import Constants from 'expo-constants';

import { createApiClient } from './api/client';
import { createEndpoints, type Endpoints } from './api/endpoints';
import { SessionManager } from './auth/session';
import { createSecureTokenStore, loadOrCreateDeviceId } from './auth/tokenStore';

export function resolveBaseUrl(): string {
  const extra = Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined;
  return extra?.apiBaseUrl ?? 'http://localhost:8080';
}

export interface AppRuntime {
  session: SessionManager;
  api: Endpoints;
  deviceId: string;
  baseUrl: string;
}

/**
 * 组装运行时依赖。
 *
 * 刷新令牌的请求本身必须走**不带会话**的裸客户端，否则刷新失败时又会触发
 * 「刷新后重放」形成递归。
 */
export async function createRuntime(onSessionExpired: () => void): Promise<AppRuntime> {
  const baseUrl = resolveBaseUrl();
  const deviceId = await loadOrCreateDeviceId();
  const store = await createSecureTokenStore();

  const bareClient = createApiClient({ baseUrl });
  const bareEndpoints = createEndpoints(bareClient);

  const session = new SessionManager({
    store,
    refresh: (refreshToken) => bareEndpoints.refresh(refreshToken, deviceId),
  });

  const client = createApiClient({ baseUrl, session, onSessionExpired });
  return { session, api: createEndpoints(client), deviceId, baseUrl };
}
