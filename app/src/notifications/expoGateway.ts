import { Platform } from 'react-native';

import { askPermission } from '../components/permission';
import { channelIdFor, currentReminderSound, type ReminderSound } from './sound';
import type { NotificationGateway, ScheduledNotification } from './scheduler';

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
      // 前台也要响：用户在设置里选的声音档位对前台同样生效，
      // 否则「选了闹钟式、结果开着 App 就不响」，用户只会以为提醒坏了。
      shouldPlaySound: currentReminderSound() !== 'silent',
      shouldSetBadge: false,
    }),
  });

  /**
   * Android 8 起通知必须挂在渠道上；没有渠道 = 系统直接丢掉这条通知。
   *
   * <p>**渠道的声音改不了**：同一个渠道 id 建好之后再改 `sound` 系统会忽略，
   * 所以三个声音档位对应三个渠道 id（见 `notifications/sound.ts`），
   * 用户改设置 = 之后的提醒换一个渠道。三个渠道都建出来，切换时不需要重建。
   */
  const prepared = new Set<ReminderSound>();
  const prepareChannel = async (sound: ReminderSound) => {
    if (Platform.OS !== 'android' || prepared.has(sound)) {
      return;
    }
    const channelId = channelIdFor(sound);
    if (sound === 'silent') {
      await Notifications.setNotificationChannelAsync(channelId, {
        name: '日程提醒（静音）',
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: null,
        enableVibrate: false,
      });
    } else if (sound === 'alarm') {
      await Notifications.setNotificationChannelAsync(channelId, {
        name: '日程提醒（闹钟式）',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'default',
        // 按闹钟音量响，并绕过免打扰：这是系统允许的最高打扰级别（仍可能被厂商省电策略拦）
        audioAttributes: {
          usage: Notifications.AndroidAudioUsage.ALARM,
          contentType: Notifications.AndroidAudioContentType.SONIFICATION,
        },
        bypassDnd: true,
        enableVibrate: true,
        vibrationPattern: [0, 400, 200, 400],
      });
    } else {
      await Notifications.setNotificationChannelAsync(channelId, {
        name: '日程提醒',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
        enableVibrate: true,
        vibrationPattern: [0, 250],
      });
    }
    prepared.add(sound);
  };

  const prepare = async () => {
    await prepareChannel(currentReminderSound());
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
      const sound = currentReminderSound();
      await prepareChannel(sound);
      return Notifications.scheduleNotificationAsync({
        content: {
          title: notification.title,
          body: notification.body,
          data: notification.data,
          /*
           * 声音交给渠道设置（Android 8+）：这里传 true/false 反而会覆盖渠道的声音。
           * iOS 没有渠道，必须在这里给 —— 静音档给 null，另外两档用系统默认音。
           */
          // iOS 没有渠道，声音必须在这里给：静音档用 false，其余用系统默认音。
          // Android 交给渠道（见上面 prepareChannel），这里给 true 表示「按渠道来」。
          sound: Platform.OS === 'ios' ? sound !== 'silent' && 'default' : true,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: notification.at,
          channelId: channelIdFor(sound),
        },
      });
    },
  };
}
