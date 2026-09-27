import { describe, expect, it } from 'vitest';

import {
  buildRrule,
  defaultRecurrence,
  describeRecurrence,
  parseRrule,
  weekdayOf,
  type Recurrence,
} from '../src/domain/recurrence';

/**
 * 重复规则（spec §4.1.2）。
 *
 * 服务端用 lib-recur 解析 RFC 5545，所以这里盯两件事：**生成的串服务端认得出**、
 * **解析回填不丢信息**（编辑一次就把用户的规则改掉，是最难被发现的 bug）。
 */
describe('重复规则', () => {
  it('从日期推出周几（周一为一周之首，别用 getUTCDay 的 0=周日）', () => {
    expect(weekdayOf('2026-09-28')).toBe('MO');
    expect(weekdayOf('2026-10-04')).toBe('SU');
    expect(weekdayOf('2026-10-03')).toBe('SA');
  });

  it('默认值 = 每周 + 勾上开始那天 + 永不结束', () => {
    const rule = defaultRecurrence('2026-09-30'); // 周三
    expect(rule.frequency).toBe('WEEKLY');
    expect(rule.byWeekday).toEqual(['WE']);
    expect(rule.endKind).toBe('NEVER');
    expect(buildRrule(rule)).toBe('FREQ=WEEKLY;BYDAY=WE');
  });

  it('生成标准 RRULE：BYDAY 按周一到周日排序，UNTIL 用日期形式', () => {
    const weekly: Recurrence = {
      frequency: 'WEEKLY',
      // 故意乱序传入，输出必须稳定
      byWeekday: ['FR', 'MO', 'WE'],
      endKind: 'UNTIL',
      untilDateKey: '2026-12-31',
      count: 10,
    };
    expect(buildRrule(weekly)).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231');
  });

  it('每天 / 每月 / 每年 不带 BYDAY', () => {
    const base = { byWeekday: [], endKind: 'NEVER' as const, untilDateKey: null, count: 10 };
    expect(buildRrule({ ...base, frequency: 'DAILY' })).toBe('FREQ=DAILY');
    expect(buildRrule({ ...base, frequency: 'MONTHLY' })).toBe('FREQ=MONTHLY');
    expect(buildRrule({ ...base, frequency: 'YEARLY' })).toBe('FREQ=YEARLY');
  });

  it('COUNT 至少要 1（0 或负数服务端不会认，也不该发出去）', () => {
    const rule: Recurrence = {
      frequency: 'DAILY', byWeekday: [], endKind: 'COUNT', untilDateKey: null, count: 0,
    };
    expect(buildRrule(rule)).toBe('FREQ=DAILY;COUNT=1');
  });

  it('不重复 → 不生成 rrule（交给服务端把 rrule 置空）', () => {
    expect(buildRrule(defaultRecurrence('2026-09-28'))).not.toBeNull();
    expect(buildRrule({ ...defaultRecurrence('2026-09-28'), frequency: 'NONE' })).toBeNull();
  });

  it('回填：服务端存的串能原样解析回来', () => {
    const parsed = parseRrule('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5', '2026-09-28');
    expect(parsed.frequency).toBe('WEEKLY');
    expect(parsed.byWeekday).toEqual(['MO', 'WE', 'FR']);
    expect(parsed.endKind).toBe('COUNT');
    expect(parsed.count).toBe(5);
  });

  it('回填：UNTIL 带时刻（lib-recur 也允许）也能认出日期', () => {
    const parsed = parseRrule('FREQ=DAILY;UNTIL=20261231T000000Z', '2026-09-28');
    expect(parsed.endKind).toBe('UNTIL');
    expect(parsed.untilDateKey).toBe('2026-12-31');
  });

  it('回填：只有 FREQ=WEEKLY 没有 BYDAY 时，按「与开始日同一天」显示（与服务端推导口径一致）', () => {
    const parsed = parseRrule('FREQ=WEEKLY', '2026-09-30'); // 周三
    expect(parsed.byWeekday).toEqual(['WE']);
  });

  it('回填：认不出的串退回「不重复」，不猜', () => {
    expect(parseRrule('FREQ=EVERY_OTHER_BLUE_MOON', '2026-09-28').frequency).toBe('NONE');
    expect(parseRrule(null, '2026-09-28').frequency).toBe('NONE');
  });

  it('往返一致：解析再生成得到同一个串', () => {
    const rrule = 'FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20270301';
    expect(buildRrule(parseRrule(rrule, '2026-09-29'))).toBe(rrule);
  });

  it('列表上的一句话描述', () => {
    expect(describeRecurrence(parseRrule('FREQ=DAILY', '2026-09-28'))).toBe('每天');
    expect(describeRecurrence(parseRrule('FREQ=WEEKLY;BYDAY=MO,WE', '2026-09-28'))).toBe('每周一、三');
    expect(describeRecurrence(parseRrule('FREQ=WEEKLY;BYDAY=MO;COUNT=5', '2026-09-28'))).toBe('每周一 · 共 5 次');
    expect(describeRecurrence(parseRrule('FREQ=MONTHLY;UNTIL=20261231', '2026-09-28')))
      .toBe('每月 · 直到 2026-12-31');
    expect(describeRecurrence(parseRrule(null, '2026-09-28'))).toBe('不重复');
  });
});
