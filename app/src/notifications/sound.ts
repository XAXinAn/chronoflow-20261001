/**
 * 提醒方式的三个档位（spec §4.5「到点提醒」）：**静音 / 消息提醒 / 闹钟**。
 *
 * <p>Android 8 起，**通知的声音由渠道决定**，而且渠道一旦建好，用户改设置后
 * 只能靠「换一个渠道 id」来换声音（同 id 改声音系统会忽略）。所以三档 = 三个渠道，
 * 而不是「同一个渠道改属性」。
 *
 * <p>「消息提醒」不是「放一段提示音」，而是**像收到一条消息那样**：通知栏里出现、
 * 响一声系统提示音并震动。与「闹钟」的差别是打扰级别，不是有没有声音。
 *
 * <p>闹钟档用 `usage = ALARM` + 绕过免打扰：这是系统允许的最高打扰级别，
 * 但它仍可能被厂商的省电策略拦掉——设置页要如实写出来，不能让用户以为「一定会响」。
 *
 * <p>**档位是按日程配的**（`reminder.sound`），这里这份是「新建日程时的默认值」。
 */

export type ReminderSound = 'silent' | 'default' | 'alarm';

export const DEFAULT_REMINDER_SOUND: ReminderSound = 'default';

export const REMINDER_SOUND_OPTIONS: { value: ReminderSound; label: string; hint: string }[] = [
  { value: 'silent', label: '静音', hint: '通知栏能看到，但不出声、不震动' },
  { value: 'default', label: '消息提醒', hint: '像收到消息一样：响一声并震动（默认）' },
  { value: 'alarm', label: '闹钟', hint: '按闹钟音量响，会绕过免打扰；部分手机会限制后台提醒' },
];

/** Android 渠道 id。**不要改这里的字符串**：改了等于所有用户已排的提醒换了渠道。 */
export function channelIdFor(sound: ReminderSound): string {
  switch (sound) {
    case 'silent':
      return 'reminders-silent';
    case 'alarm':
      return 'reminders-alarm';
    default:
      return 'reminders-default';
  }
}

export function describeReminderSound(sound: ReminderSound): string {
  return REMINDER_SOUND_OPTIONS.find((option) => option.value === sound)?.label ?? '消息提醒';
}

/** 原始值（存储 / 服务端）→ 合法档位；认不出一律回默认（宁可响，也不要静默失效）。 */
export function parseReminderSound(raw: unknown): ReminderSound {
  return raw === 'silent' || raw === 'default' || raw === 'alarm' ? raw : DEFAULT_REMINDER_SOUND;
}

/**
 * 当前「新建日程时的默认档位」。
 *
 * <p>真正的档位跟着**每条日程**走（`reminder.sound`）；这个模块级变量只负责两件事：
 * ① 新日程/待办的默认值；② 排期时若某条通知没带档位时的兜底。
 * 设置页改动时写进来，并触发一次重排。
 */
let current: ReminderSound = DEFAULT_REMINDER_SOUND;

export function currentReminderSound(): ReminderSound {
  return current;
}

export function setCurrentReminderSound(sound: ReminderSound): void {
  current = sound;
}
