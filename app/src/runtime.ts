import Constants from 'expo-constants';
import { Platform } from 'react-native';

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
  if (!localNotificationsAvailable()) {
    return createNoopReminderScheduler();
  }
  try {
    const gateway = await createExpoNotificationGateway();
    const store = await createSecureReminderIdStore();
    return createReminderScheduler({ gateway, store });
  } catch {
    return createNoopReminderScheduler();
  }
}

/**
 * 本机能不能用 `expo-notifications`。
 *
 * **Expo Go（Android）从 SDK 53 起移除了这个模块**：只要 `import('expo-notifications')`
 * 就会在模块求值阶段抛「Android Push notifications functionality was removed from Expo Go」，
 * 而且这个错误会被 Expo 的 LogBox 当成未捕获错误弹红框（catch 住也没用，模块工厂自己报的）。
 * 所以在 Expo Go 里直接跳过：日程/待办的其它功能照常，只是本机不排提醒 —— 与
 * 「切换设备后新设备默认开启」那条降级口径一致，不骗用户。
 *
 * 想在模拟器/真机上验证**到点提醒真的会响**，必须用开发构建（`expo-dev-client` / `expo run:android`）。
 */
function localNotificationsAvailable(): boolean {
  if (Platform.OS !== 'android') {
    return true;
  }
  // executionEnvironment: 'storeClient' = Expo Go；'standalone' / 'bare' = 独立包或开发构建
  return Constants.executionEnvironment !== 'storeClient';
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
