import { Platform } from 'react-native';

import { askPermission } from '../components/permission';
import type { NotificationGateway, ScheduledNotification } from './scheduler';

/** Android 8 起通知必须挂在渠道上；没有渠道 = 系统直接丢掉这条通知。 */
const CHANNEL_ID = 'reminders';

/**
 * `expo-notifications` 的适配层（spec §4.5：到点提醒走 App 本地通知，不经过服务端推送）。
 *
 * 用动态 import 而不是顶层 import：原生模块在「Web 预览 / 缺模块的构建」里不存在，
 * 顶层 import 会让整个 App 起不来。这里是唯一碰原生通知 API 的地方，
 * 其余逻辑都在 `scheduler.ts` 里，可以在 node 下单测。
 */
export async function createExpoNotificationGateway(): Promise<NotificationGateway> {
  const Notifications = await import('expo-notifications');

  /**
   * 前台也要弹。
   *
   * 默认前台不显示通知 —— 用户正好开着 App 时会以为提醒根本没生效（spec §4.1.2 的承诺落空）。
   * 静音、不加角标：日程提醒是「看一眼」，不该按闹钟的标准打扰人。
   */
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  let prepared = false;
  const prepare = async () => {
    if (prepared) {
      return;
    }
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: '日程提醒',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    prepared = true;
  };

  return {
    async ensurePermission() {
      await prepare();
      /**
       * 走统一的权限入口，而不是直接 `requestPermissionsAsync()`：
       * 审核规范要求**先用自己的文案说明用途、再弹系统窗**，拒绝后只提示并给「去设置」，
       * 绝不退出 App（spec §12.5）。已有权限时它也不会重复打扰。
       *
       * 系统记住「不再询问」的情况也由它兜住：request 返回 false → 走 reject 提示。
       */
      return askPermission('notification');
    },

    async cancelAll(ids) {
      await prepare();
      await Promise.all(ids.map((id) => Notifications.cancelScheduledNotificationAsync(id)));
    },

    async schedule(notification: ScheduledNotification) {
      await prepare();
      return Notifications.scheduleNotificationAsync({
        content: {
          title: notification.title,
          body: notification.body,
          data: notification.data,
          // 声音交给渠道设置，这里显式静音（日程提醒不是闹钟）
          sound: false,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: notification.at,
          channelId: CHANNEL_ID,
        },
      });
    },
  };
}
