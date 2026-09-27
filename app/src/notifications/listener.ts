import { routeFromResponse, type NotificationRoute } from './route';

/**
 * 监听「用户点了本地通知」（spec §4.5）。
 *
 * 两种时机都要覆盖，少一个就会出现「点了通知没反应」：
 *   1. **App 已经在运行**：`addNotificationResponseReceivedListener`；
 *   2. **App 是被通知点开的**（冷启动）：那一次点击发生在监听注册之前，
 *      只能靠 `getLastNotificationResponseAsync` 补捞。
 *
 * 与其它通知模块一样用动态 import：Web 预览 / 缺原生模块时不影响 App 启动。
 */
export async function subscribeNotificationResponses(
  handler: (route: NotificationRoute) => void,
): Promise<() => void> {
  const Notifications = await import('expo-notifications');
  const emit = (response: unknown) => {
    const route = routeFromResponse(response as never);
    if (route) {
      handler(route);
    }
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(emit);
  try {
    emit(await Notifications.getLastNotificationResponseAsync());
  } catch {
    // 拿不到「上次点击」不影响运行中的监听
  }
  return () => subscription.remove();
}
