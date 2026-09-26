import { describe, expect, it } from 'vitest';

import {
  buildDispatchPayload,
  buildUpdatePayload,
  canDispatch,
  nextDateKey,
  validateDispatchForm,
  withStartTime,
  type DispatchForm,
} from '../src/domain/orgDispatch';

function form(overrides: Partial<DispatchForm> = {}): DispatchForm {
  return {
    title: '季度评审会',
    description: '',
    location: '',
    dateKey: '2026-09-26',
    allDay: false,
    startTime: '09:00',
    endTime: '10:00',
    memberIds: [11, 12],
    ...overrides,
  };
}

describe('组织日程下发', () => {
  it('普通成员没有任何可下发的人，入口应当直接不显示', () => {
    expect(canDispatch({ orgAdmin: false, manageableDepartmentIds: [] })).toBe(false);
    expect(canDispatch({ orgAdmin: true, manageableDepartmentIds: [] })).toBe(true);
    expect(canDispatch({ orgAdmin: false, manageableDepartmentIds: [2] })).toBe(true);
  });

  it('一个人都没选 → 拦住，而不是提交一个必然失败的请求', () => {
    expect(validateDispatchForm(form({ memberIds: [] })))
      .toEqual({ ok: false, message: '请选择下发对象' });
  });

  it('标题为空 → 拦住', () => {
    expect(validateDispatchForm(form({ title: '   ' })))
      .toEqual({ ok: false, message: '请填写日程标题' });
  });

  it('结束时间不晚于开始时间 → 拦住', () => {
    expect(validateDispatchForm(form({ startTime: '15:00', endTime: '09:00' })))
      .toEqual({ ok: false, message: '结束时间要晚于开始时间' });
  });

  it('开始时间改动时结束时间跟着 +1 小时', () => {
    expect(withStartTime(form(), '14:30')).toMatchObject({ startTime: '14:30', endTime: '15:30' });
  });

  it('全天日程按整天提交，避免成员端显示成 00:00–00:00 的零长日程', () => {
    const payload = buildDispatchPayload(form({ allDay: true }), 'Asia/Shanghai');
    expect(payload.startAt).toBe('2026-09-26T00:00:00+08:00');
    expect(payload.endAt).toBe('2026-09-27T00:00:00+08:00');
    expect(nextDateKey('2026-09-30')).toBe('2026-10-01');
  });

  it('下发对象就是一份人名单：提交 MEMBER 范围 + memberIds', () => {
    const payload = buildDispatchPayload(form({ memberIds: [3, 5, 8] }), 'Asia/Shanghai');
    expect(payload.scopeType).toBe('MEMBER');
    expect(payload.memberIds).toEqual([3, 5, 8]);
    expect(payload.departmentId).toBeUndefined();
  });

  it('空白的地点/说明不提交，避免把空串写进库里', () => {
    const payload = buildDispatchPayload(form({ location: '   ', description: '' }), 'Asia/Shanghai');
    expect(payload.location).toBeUndefined();
    expect(payload.description).toBeUndefined();
  });

  it('编辑组织日程：不改下发名单，只提交内容与时间（空串表示清空）', () => {
    const payload = buildUpdatePayload(
      form({ title: '改后标题', description: '', location: 'A 座 3F' }),
      'Asia/Shanghai',
    );
    expect(payload).toMatchObject({
      title: '改后标题',
      description: '',
      location: 'A 座 3F',
      startAt: '2026-09-26T09:00:00+08:00',
      endAt: '2026-09-26T10:00:00+08:00',
      allDay: false,
    });
    // 编辑请求体里没有 memberIds：范围只能靠「撤回 + 重新下发」改
    expect(payload).not.toHaveProperty('memberIds');
  });
});
