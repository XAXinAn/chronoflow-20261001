import { describe, expect, it } from 'vitest';

import {
  channelIdFor,
  currentReminderSound,
  DEFAULT_REMINDER_SOUND,
  describeReminderSound,
  parseReminderSound,
  setCurrentReminderSound,
} from '../src/notifications/sound';

describe('提醒声音档位', () => {
  it('三档各有自己的 Android 渠道（渠道声音建好后改不了，只能换 id）', () => {
    const ids = [channelIdFor('silent'), channelIdFor('default'), channelIdFor('alarm')];
    expect(new Set(ids).size).toBe(3);
  });

  it('认不出的值回到默认音，而不是静音', () => {
    expect(parseReminderSound('alarm')).toBe('alarm');
    expect(parseReminderSound('silent')).toBe('silent');
    expect(parseReminderSound(undefined)).toBe(DEFAULT_REMINDER_SOUND);
    expect(parseReminderSound('nonsense')).toBe(DEFAULT_REMINDER_SOUND);
    expect(DEFAULT_REMINDER_SOUND).not.toBe('silent');
  });

  it('网关读的是模块级当前档位，设置页改完立刻生效', () => {
    setCurrentReminderSound('alarm');
    expect(currentReminderSound()).toBe('alarm');
    setCurrentReminderSound(DEFAULT_REMINDER_SOUND);
    expect(currentReminderSound()).toBe(DEFAULT_REMINDER_SOUND);
  });

  it('每个档位都有给用户看的说明', () => {
    expect(describeReminderSound('silent')).toBe('静音');
    expect(describeReminderSound('default')).toBe('消息提醒');
    expect(describeReminderSound('alarm')).toBe('闹钟');
  });
});
