import type { EventPlace } from './eventDraft';

/**
 * 拍照 / 相册识别日程的纯逻辑（spec §4.1.9）。
 *
 * 识别结果一律**先给用户确认**再落库：模型会看错，直接写进日历比看错更糟。
 * 而且结果要**可编辑**——模型给的标题、时间、归类都可能差一点，用户改两个字就对了，
 * 让他重新手打一遍等于白识别。
 */

export type DraftKind = 'EVENT' | 'TASK';

/** 识别出的一条草稿。时间字段为空表示**没看出时间**。 */
export interface RecognizedEventDraft {
  title: string;
  /** 模型判断这是日程还是待办；用户可以在结果页改 */
  kind?: DraftKind | null;
  startAt?: string | null;
  endAt?: string | null;
  /** 待办的截止时间（「登记截止 9/24」落在这里） */
  dueAt?: string | null;
  allDay?: boolean | null;
  locationName?: string | null;
  /** 正文要点：地址、链接、要求 */
  description?: string | null;
  confidence?: number | null;
  /**
   * 已在**高德**解析到的结构化地点（spec §5.9）。
   *
   * <p>识别出来的地名（「A座3F报告厅」）只是文本，能不能导航是另一回事：
   * 匹配不到就宁可留空，也不留一段谁也定位不了的自由文本。
   */
  place?: EventPlace | null;
  /** 识别到地名但高德没匹配上：界面要说明「已留空」，别让用户以为地点还在 */
  locationUnmatched?: boolean;
}

/**
 * 按类型分组。
 *
 * <p>以模型的 `kind` 为准，没给才按「有没有开始时间」兜底——
 * 注意「登记截止 9/24」同样是个时间，只按时间判会把待办误判成日程。
 */
export function draftKind(draft: RecognizedEventDraft): DraftKind {
  if (draft.kind) {
    return draft.kind;
  }
  return draft.startAt ? 'EVENT' : 'TASK';
}

export function splitDrafts(drafts: RecognizedEventDraft[]): {
  events: RecognizedEventDraft[];
  tasks: RecognizedEventDraft[];
} {
  const events: RecognizedEventDraft[] = [];
  const tasks: RecognizedEventDraft[] = [];
  for (const draft of drafts) {
    if (draftKind(draft) === 'EVENT' && draft.startAt) {
      events.push(draft);
    } else {
      tasks.push(draft);
    }
  }
  return { events, tasks };
}

/** 待办截止时间：`dueAt` 优先；模型只给一个时间时把它当截止。 */
export function taskDueAt(draft: RecognizedEventDraft): string | null {
  return draft.dueAt ?? draft.startAt ?? null;
}

/** 日程结束时间缺失时默认 1 小时（全天日程默认 +1 天）。 */
export function endAtOrDefault(draft: RecognizedEventDraft): string {
  if (draft.endAt) {
    return draft.endAt;
  }
  const start = new Date(draft.startAt as string);
  const span = draft.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return new Date(start.getTime() + span).toISOString();
}

/**
 * 解析用户在结果页手改的时间，接受 `2026-09-26 15:00`、`2026/9/26`、`2026-09-26T15:00:00` 等写法。
 *
 * <p>解析不出来就返回 null（调用方标红提示），**绝不猜**一个时间——
 * 猜错的时间比空着更难发现。
 */
export function parseEditedTime(input: string | null | undefined): string | null {
  const text = (input ?? '').trim().replace(/\//g, '-').replace(' ', 'T');
  if (!text) {
    return null;
  }
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2}):(\d{2}))?$/.exec(text);
  if (!matched) {
    return null;
  }
  const [, year, month, day, hour, minute] = matched;
  const pad = (value: string) => value.padStart(2, '0');
  // 固定按 App 统一时区（Asia/Shanghai）解释用户输入，不跟设备时区走
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour ?? '0')}:${pad(minute ?? '00')}:00+08:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : iso;
}

/** 置信度文案：模型没给就不显示；偏低提示核对。 */
export function confidenceLabel(confidence?: number | null): string | null {
  if (confidence === null || confidence === undefined) {
    return null;
  }
  return confidence >= 0.8 ? '识别把握较大' : '建议核对';
}

/** 创建结果的汇总文案。 */
export function createdSummary(eventCount: number, taskCount: number): string {
  const parts: string[] = [];
  if (eventCount > 0) {
    parts.push(`${eventCount} 条日程`);
  }
  if (taskCount > 0) {
    parts.push(`${taskCount} 条待办`);
  }
  return parts.length === 0 ? '没有可创建的内容' : `已创建 ${parts.join(' 和 ')}`;
}

/**
 * 把高德解析结果落到草稿上（spec §4.1.9 × §5.9）。
 *
 * <p>模型给出地名、高德又找得到 → 记结构化地点（含坐标，能导航）；
 * 找不到 → **地点留空**并标 `locationUnmatched`，由用户手动选或干脆不要地点。
 */
export function applyResolvedPlace(
  draft: RecognizedEventDraft,
  place: RecognizedEventDraft['place'],
): RecognizedEventDraft {
  if (!place) {
    return { ...draft, place: null, locationUnmatched: Boolean(draft.locationName) };
  }
  return { ...draft, place, locationName: place.name, locationUnmatched: false };
}
