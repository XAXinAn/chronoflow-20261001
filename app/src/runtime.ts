import Constants from 'expo-constants';

import { createApiClient } from './api/client';
import { createEndpoints, type Endpoints } from './api/endpoints';
import { SessionManager } from './auth/session';
import { createSecureTokenStore, loadOrCreateDeviceId } from './auth/tokenStore';
import { createExpoNotificationGateway } from './notifications/expoGateway';
import { createSecureReminderIdStore } from './notifications/reminderStore';
import {
  createNoopReminderScheduler,
  createReminderScheduler,
  type ReminderScheduler,
} from './notifications/scheduler';

export function resolveBaseUrl(): string {
  const extra = Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined;
  return extra?.apiBaseUrl ?? 'http://localhost:8080';
}

export interface AppRuntime {
  session: SessionManager;
  api: Endpoints;
  /** 本机提醒排期（spec §4.5：到点提醒走本地通知，不经过服务端推送） */
  reminders: ReminderScheduler;
  deviceId: string;
  baseUrl: string;
}

/**
 * 组装本地提醒排期。
 *
 * 通知模块缺失（Web 预览、缺原生模块的构建）时降级成空实现而不是让 App 起不来：
 * 提醒排不了只是少一个功能，打不开 App 是事故。
 */
async function createReminderSchedulerSafe(): Promise<ReminderScheduler> {
  try {
    const gateway = await createExpoNotificationGateway();
    const store = await createSecureReminderIdStore();
    return createReminderScheduler({ gateway, store });
  } catch {
    return createNoopReminderScheduler();
  }
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
  return {
    session,
    api: createEndpoints(client),
    reminders: await createReminderSchedulerSafe(),
    deviceId,
    baseUrl,
  };
}
