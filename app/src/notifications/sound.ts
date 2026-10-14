/**
 * 提醒声音的三个档位（spec §4.5「到点提醒」）。
 *
 * <p>Android 8 起，**通知的声音由渠道决定**，而且渠道一旦建好，用户改设置后
 * 只能靠「换一个渠道 id」来换声音（同 id 改声音系统会忽略）。所以三档 = 三个渠道，
 * 而不是「同一个渠道改属性」。
 *
 * <p>闹钟档用 `usage = ALARM` + 绕过免打扰：这是系统允许的最高打扰级别，
 * 但它仍可能被厂商的省电策略拦掉——设置页要如实写出来，不能让用户以为「一定会响」。
 */

export type ReminderSound = 'silent' | 'default' | 'alarm';

export const DEFAULT_REMINDER_SOUND: ReminderSound = 'default';

export const REMINDER_SOUND_OPTIONS: { value: ReminderSound; label: string; hint: string }[] = [
  { value: 'silent', label: '静音', hint: '只在通知栏出现，不响也不震' },
  { value: 'default', label: '系统提示音', hint: '响一声系统提示音并震动（默认）' },
  { value: 'alarm', label: '闹钟式', hint: '按闹钟音量响铃，会绕过免打扰；部分手机会限制后台提醒' },
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
  return REMINDER_SOUND_OPTIONS.find((option) => option.value === sound)?.label ?? '系统提示音';
}

/** 存储里的原始值 → 合法档位；认不出一律回默认（宁可响，也不要静默失效）。 */
export function parseReminderSound(raw: unknown): ReminderSound {
  return raw === 'silent' || raw === 'default' || raw === 'alarm' ? raw : DEFAULT_REMINDER_SOUND;
}

/**
 * 当前生效的声音档位。
 *
 * <p>为什么用模块级变量而不是把它一路透传进排期：通知是在「保存日程」时排的，
 * 那一刻要用的就是**此刻的全局设置**；把它塞进每个调用点只会让签名到处都是这个参数。
 * 设置页改动时写进来，并触发一次重排（否则旧渠道的通知仍按旧声音响）。
 */
let current: ReminderSound = DEFAULT_REMINDER_SOUND;

export function currentReminderSound(): ReminderSound {
  return current;
}

export function setCurrentReminderSound(sound: ReminderSound): void {
  current = sound;
}
