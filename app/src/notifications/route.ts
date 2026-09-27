/**
 * 通知点击后要跳到哪儿（spec §4.5「通知点击统一路由」）。
 *
 * 排期时我们把 `targetType / targetId / occurrenceDate` 放进了通知的 data
 * （见 scheduler.ts），这里把它翻译成一条导航意图；解析不出的通知一律忽略 ——
 * 旧版本排下的通知、别人手工构造的 data，都不该让 App 崩在启动路径上。
 */
export type NotificationRoute =
  | { kind: 'EVENT'; eventId: number; occurrenceDate: string | null }
  | { kind: 'TASK'; taskId: number };

export function routeFromNotificationData(data: unknown): NotificationRoute | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const record = data as Record<string, unknown>;
  const targetId = Number(record.targetId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return null;
  }
  const occurrenceDate =
    typeof record.occurrenceDate === 'string' && record.occurrenceDate ? record.occurrenceDate : null;
  if (record.targetType === 'EVENT') {
    return { kind: 'EVENT', eventId: targetId, occurrenceDate };
  }
  if (record.targetType === 'TASK') {
    return { kind: 'TASK', taskId: targetId };
  }
  return null;
}

/** 通知里的一次点击（只取我们要的那一层，便于在测试里造假对象）。 */
export interface NotificationResponseLike {
  notification?: { request?: { content?: { data?: unknown } } };
}

export function routeFromResponse(response: NotificationResponseLike | null): NotificationRoute | null {
  return routeFromNotificationData(response?.notification?.request?.content?.data);
}
