import type { OrgDispatchRequest } from '../api/types';
import { parseTime, toIso, type DraftValidation } from './eventDraft';

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
  /** 详细地址：地图定位不到的那一层，由用户手填（与地点都可空，spec §5.9） */
  locationDetail: string;
  dateKey: string;
  /** 组织日程的唯一时间（HH:mm）；拨到 00:00 就是「就这一天」 */
  time: string;
  /** 下发对象：成员 id 列表（在选人页里挑好后回填） */
  memberIds: number[];
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
  // 用 parseTime 而不是 toIso：非法时刻 toIso 会抛，抛出去就变成崩溃而不是表单错误
  if (!parseTime(form.time)) {
    return { ok: false, message: '时间要写成 09:00 这样的格式' };
  }
  return { ok: true };
}

/**
 * 表单 → 下发请求体。
 *
 * 组织日程与个人日程一样只有**一个时间点**（spec §4.1.2）；时间拨到 00:00 就是「就这一天」。
 */
export function buildDispatchPayload(form: DispatchForm, timezone: string): OrgDispatchRequest {
  const at = toIso(form.dateKey, form.time);

  const payload: OrgDispatchRequest = {
    title: form.title.trim(),
    at,
    timezone,
    // 下发对象就是人名单：服务端按 MEMBER 范围逐个校验「这个人我能不能下发」
    scopeType: 'MEMBER',
    memberIds: form.memberIds,
  };
  if (form.description.trim()) {
    payload.description = form.description.trim();
  }
  if (form.location.trim()) {
    payload.location = form.location.trim();
  }
  if (form.locationDetail.trim()) {
    payload.locationDetail = form.locationDetail.trim();
  }
  return payload;
}



/**
 * 编辑组织日程的请求体（只有发起人能改，spec §4.2.2）。
 *
 * 与新建的差别：**下发对象改不了**——已经发出去的通知，改范围等于换一批收件人，
 * 语义上是「撤回 + 重新下发」，服务端也不接受在 PATCH 里改目标。
 */
export function buildUpdatePayload(form: DispatchForm, timezone: string) {
  return {
    title: form.title.trim(),
    // PATCH 的语义：null 表示不修改，空串才是清空（与个人日程编辑页一致）
    description: form.description.trim(),
    location: form.location.trim(),
    locationDetail: form.locationDetail.trim(),
    at: toIso(form.dateKey, form.time),
    timezone,
  };
}
