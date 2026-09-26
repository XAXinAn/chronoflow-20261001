import type { OrgDispatchRequest } from '../api/types';
import { addMinutes, toIso, type DraftValidation } from './eventDraft';

/**
 * 新建组织日程的表单逻辑（spec §4.2.2 / §4.2.3）。
 *
 * 下发对象是**一份人名单**（`memberIds`），不是「全组织 / 部门」这种抽象粒度：
 * 组织日程最终落到的就是「哪些人收到了」，选择也该按人来选。
 * 名单在服务端按下发那一刻快照展开，之后新入组的人不补收。
 */

export interface DispatchForm {
  title: string;
  description: string;
  location: string;
  dateKey: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  /** 下发对象：成员 id 列表（在选人页里挑好后回填） */
  memberIds: number[];
  requireReceipt: boolean;
}

/** 能下发的人：组织管理员，或被授权了某些部门的部门管理员（spec §4.2.2）。 */
export function canDispatch(org: {
  orgAdmin: boolean;
  manageableDepartmentIds: number[];
}): boolean {
  return org.orgAdmin || org.manageableDepartmentIds.length > 0;
}

/** 表单校验。返回第一条错误，没有错误就 ok。 */
export function validateDispatchForm(form: DispatchForm): DraftValidation {
  if (!form.title.trim()) {
    return { ok: false, message: '请填写日程标题' };
  }
  if (form.memberIds.length === 0) {
    return { ok: false, message: '请选择下发对象' };
  }
  if (!form.allDay) {
    const start = toIso(form.dateKey, form.startTime);
    const end = toIso(form.dateKey, form.endTime);
    if (!start || !end) {
      return { ok: false, message: '开始与结束时间要写成 09:00 这样的格式' };
    }
    if (end <= start) {
      return { ok: false, message: '结束时间要晚于开始时间' };
    }
  }
  return { ok: true };
}

/**
 * 表单 → 下发请求体。
 *
 * 全天日程按「当天 00:00 到次日 00:00」提交：后端只认 startAt/endAt，
 * 而 `allDay` 是展示语义——不把跨度写成整天，成员端就会显示成 00:00–00:00 的零长日程。
 */
export function buildDispatchPayload(form: DispatchForm, timezone: string): OrgDispatchRequest {
  const startAt = form.allDay ? toIso(form.dateKey, '00:00') : toIso(form.dateKey, form.startTime);
  const endAt = form.allDay
    ? toIso(nextDateKey(form.dateKey), '00:00')
    : toIso(form.dateKey, form.endTime);

  const payload: OrgDispatchRequest = {
    title: form.title.trim(),
    startAt,
    endAt,
    allDay: form.allDay,
    timezone,
    // 下发对象就是人名单：服务端按 MEMBER 范围逐个校验「这个人我能不能下发」
    scopeType: 'MEMBER',
    memberIds: form.memberIds,
    requireReceipt: form.requireReceipt,
  };
  if (form.description.trim()) {
    payload.description = form.description.trim();
  }
  if (form.location.trim()) {
    payload.location = form.location.trim();
  }
  return payload;
}

/** 结束时间跟随开始 +1 小时：少让用户手打一次时间（与个人日程编辑页同一套交互）。 */
export function withStartTime(form: DispatchForm, startTime: string): DispatchForm {
  return { ...form, startTime, endTime: addMinutes(startTime, 60) };
}

export function nextDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const pad = (value: number) => (value < 10 ? `0${value}` : `${value}`);
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}
