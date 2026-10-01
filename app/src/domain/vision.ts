/**
 * 「拍照/相册 → 识别日程」的纯逻辑（spec §4.1.9）。
 *
 * 这条链路分三段：端侧 OCR（图片 → 文字，图片不出手机）→ 服务端解析
 * （`POST /ai/events/parse-text`，文字 → 日程草稿）→ **确认页**（用户补日期 / 改标题）→ 落库。
 *
 * 服务端交给我们的草稿里，`at` 可能是空的（通知里根本没写日期），且时刻一律是
 * 「当天 00:00 / 或原文写明的时刻」。本文件只做两件不碰原生、可单测的事：
 * ① 把服务端返回的 items **容错**归一成草稿；② 把确认页上的草稿**映射成创建请求**。
 */

import type { ParsedEventItem } from '../api/types';
import { localDateKey } from './agenda';
import { APP_TIMEZONE, APP_UTC_OFFSET } from './calendar';
import { emptyDraft, timeInZone, type EventDraft } from './eventDraft';

/**
 * 识别出的一条草稿。
 *
 * `at` 为空 / 缺失表示**通知里没写日期**——这是合法结果，由确认页让用户补，
 * 我们既不丢这条、也不拿今天兜底。
 */
export interface RecognizedDraft {
  title: string;
  /** 时间点（带偏移量的 ISO）；null / undefined = 没写日期 */
  at?: string | null;
  /** 解释 `at` 用的时区（服务端回带）；缺省按 App 统一时区 */
  timezone?: string | null;
  locationName?: string | null;
  description?: string | null;
}

/**
 * 把服务端 `parse-text` 的 items 归一成草稿。
 *
 * 容错优先：服务端把空字段省掉（`non_null`），所以这里一律把 undefined / 空串当「没有」；
 * 没标题的条目没法确认也没法建，直接丢掉。
 */
export function draftsFromItems(items: ParsedEventItem[] | null | undefined): RecognizedDraft[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const drafts: RecognizedDraft[] = [];
  for (const item of items) {
    const title = text(item?.title);
    if (!title) {
      continue;
    }
    drafts.push({
      title,
      at: normalizeTime(item.at ?? null),
      timezone: text(item.timezone),
      locationName: text(item.locationName),
      description: text(item.description),
    });
  }
  return drafts;
}

/**
 * 一条草稿落在哪一天（用它自己的时区解释）；**没日期就返回 null**。
 *
 * 返回 `YYYY-MM-DD` 而不是直接拿字符串前 10 位：`at` 带偏移量，
 * 换算到目标时区后可能落到前 / 后一天（服务端也会回带它认定「只说了哪天」的日期）。
 */
export function draftDateKey(draft: RecognizedDraft, fallbackTimeZone = APP_TIMEZONE): string | null {
  if (!draft.at) {
    return null;
  }
  if (Number.isNaN(Date.parse(draft.at))) {
    return null;
  }
  return localDateKey(draft.at, draft.timezone || fallbackTimeZone);
}

/**
 * 把一条识别草稿铺成**日程编辑器用的草稿**（`EventDraft`）。
 *
 * 确认页里点开草稿就进整页编辑器，字段与「编辑日程」完全一致（标题 / 日期 / 时间 /
 * 地点 / 详细地址 / 备注 / 重复 / 提醒），所以这里要先把模型给的少量字段铺成完整草稿：
 * 其余字段用 `emptyDraft()` 的默认值填上，用户在编辑器里改。
 *
 * - **时间**：模型给了就用（只说了哪天的就是 00:00，即「就这一天」），用户可再调；
 * - **地点**：模型抽到的地点只有名字、没有坐标，先当「手工地点」放进去——
 *   用户可以保留、清掉，或在编辑页里换成地图选点；
 * - **日期**不在这里：它是 `draftDateKey()` 的产物，确认页与编辑器各自持有。
 */
export function draftToEventDraft(draft: RecognizedDraft): EventDraft {
  const zone = draft.timezone || APP_TIMEZONE;
  const base = emptyDraft();
  return {
    ...base,
    title: draft.title.trim(),
    time: draft.at ? timeInZone(draft.at, zone) : base.time,
    place: text(draft.locationName)
      ? { poiId: null, name: text(draft.locationName) as string, address: null, latitude: null, longitude: null }
      : null,
    description: draft.description ?? '',
  };
}

/**
 * 把服务端 / 手输的时间规整成带时区的 ISO。
 *
 * 服务端回带的已经是带偏移量的 ISO；这里再兜一层：只有日期 → 当天 00:00；
 * 没有偏移量 → 按 `+08:00` 补。解析不了就返回 null：**绝不猜**一个时间。
 */
export function normalizeTime(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)$/.test(trimmed)) {
    return Number.isNaN(Date.parse(trimmed)) ? null : trimmed;
  }
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (!matched) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = matched;
  const pad = (part: string | undefined) => (part ?? '0').padStart(2, '0');
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${APP_UTC_OFFSET}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function text(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
