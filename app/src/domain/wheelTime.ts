/**
 * 滚轮时间选择器的纯计算（spec §4.1.5 / §7.6.7）。
 *
 * 编辑页原先是**手打** `HH:mm` 的文本框 —— 真机上这就是一次次输错：
 * 全键盘上要先切到数字、冒号容易漏、光标位置还不好放，输错了只能等到点「保存」
 * 才被告知「时间格式应为 HH:mm」（本机模拟器联调时实测踩到）。
 * 时间与日期一样是「有限取值 + 需要快拨」，正是滚轮该干的事。
 */

/** 时 / 分两列的取值范围。 */
export function hours(): number[] {
  return Array.from({ length: 24 }, (_, index) => index);
}

export function minutes(): number[] {
  return Array.from({ length: 60 }, (_, index) => index);
}

/** 值非法时的兜底（新建待办/日程的默认时间就是这个）——**绝不**让滚轮停在非法位置。 */
export const FALLBACK_TIME = '09:00';

/**
 * `HH:mm` → 时 / 分。
 *
 * 认不出的值一律回落到 `09:00`：滚轮必须停在一个合法位置上，
 * 停在「undefined 时」只会让用户一脸问号。
 */
export function parseTimeParts(value: string): { hour: number; minute: number } {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!matched) {
    return { hour: 9, minute: 0 };
  }
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return { hour: 9, minute: 0 };
  }
  return { hour, minute };
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 时 / 分 → `HH:mm`，并把越界值夹回合法范围（滚轮理论上不会越界，但拼装处要对得起类型）。 */
export function composeTime(hour: number, minute: number): string {
  const safeHour = Math.min(Math.max(Math.trunc(hour), 0), 23);
  const safeMinute = Math.min(Math.max(Math.trunc(minute), 0), 59);
  return `${pad(safeHour)}:${pad(safeMinute)}`;
}
