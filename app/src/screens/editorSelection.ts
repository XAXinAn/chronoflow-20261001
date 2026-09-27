import type { EventPlace } from '../domain/eventDraft';
import type { Recurrence } from '../domain/recurrence';

/**
 * 二级页回传给编辑页的参数。
 *
 * 一律带 `version`：像「不设地点」「不重复」「不提醒」这类结果，值本身和「没改过」
 * 长得一模一样（都是 null / 空数组），只比较值就分不出「用户又选了一次」，
 * 界面会停在旧状态。version 只在用户按下「完成 / 确定」时 +1。
 */

/** 地点选择的回传：用 version 区分「重新选了同一个地点」与「选了不设地点」。 */
export interface PlaceSelection {
  version: number;
  place: EventPlace | null;
}

export interface RecurrenceSelection {
  version: number;
  recurrence: Recurrence | null;
}

export interface ReminderSelection {
  version: number;
  minutes: number[];
}
