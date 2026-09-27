import { describe, expect, it } from 'vitest';

import { composeTime, hours, minutes, parseTimeParts } from '../src/domain/wheelTime';

/**
 * 滚轮时间选择器的计算（spec §4.1.5）。
 *
 * 这一层替掉的是「手打 HH:mm」：滚轮只会产生合法值，所以这里的重点是
 * **回填到滚轮位置**不能出错（服务端给的值要能还原成两列的下标），
 * 以及拼装时把越界值夹回去。
 */
describe('滚轮时间选择器', () => {
  it('两列的取值范围：0-23 时 / 0-59 分', () => {
    expect(hours()).toHaveLength(24);
    expect(hours()[0]).toBe(0);
    expect(hours()[23]).toBe(23);
    expect(minutes()).toHaveLength(60);
    expect(minutes()[59]).toBe(59);
  });

  it('回填：HH:mm 还原成两列的下标', () => {
    expect(parseTimeParts('21:28')).toEqual({ hour: 21, minute: 28 });
    expect(parseTimeParts('09:05')).toEqual({ hour: 9, minute: 5 });
    // 手输时代留下的不补零写法也要能认
    expect(parseTimeParts('9:05')).toEqual({ hour: 9, minute: 5 });
  });

  it('回填：认不出或越界的值停到 09:00，绝不让滚轮停在非法位置', () => {
    expect(parseTimeParts('')).toEqual({ hour: 9, minute: 0 });
    expect(parseTimeParts('随便写')).toEqual({ hour: 9, minute: 0 });
    expect(parseTimeParts('25:00')).toEqual({ hour: 9, minute: 0 });
    expect(parseTimeParts('10:60')).toEqual({ hour: 9, minute: 0 });
  });

  it('拼装：补零，越界值夹回合法范围', () => {
    expect(composeTime(9, 5)).toBe('09:05');
    expect(composeTime(21, 28)).toBe('21:28');
    expect(composeTime(0, 0)).toBe('00:00');
    expect(composeTime(-1, -1)).toBe('00:00');
    expect(composeTime(24, 70)).toBe('23:59');
  });
});
