import { describe, expect, it } from 'vitest';

import type { AgentAction } from '../src/domain/agentStream';
import {
  cardInMessage,
  describeActionPreview,
  dropSupersededCards,
  headPendingCard,
  mergeActionCards,
  resolveCard,
  skipPendingCards,
  type AgentActionCard,
} from '../src/domain/agentActions';

/**
 * 授权卡片这一层的纯逻辑。
 *
 * <p>写操作现在由**服务端**在 agent 循环里执行（mewcode 的权限层），所以这里只剩
 * 「卡片怎么显示、怎么合并、怎么定位到具体哪一条」——不再有「点了确认该调哪个 REST」。
 */

const createAction: AgentAction = {
  actionId: 'a1',
  type: 'create_event',
  summary: '创建日程：张总会 9/28 15:00',
  payload: {
    title: '张总会',
    at: '2026-09-28T15:00:00+08:00',
    locationName: '会议室 A',
  },
};

const deleteAction: AgentAction = {
  actionId: 'a2',
  type: 'delete_event',
  summary: '删除日程：张总会 9/28 15:00',
  payload: { eventId: 42, title: '张总会', at: '2026-09-28T15:00:00+08:00' },
};

function card(action: AgentAction, status: AgentActionCard['status']): AgentActionCard {
  return { action, status };
}

describe('卡片展示「将写入的日程」', () => {
  it('建日程的卡片显示标题、日期与时间', () => {
    const preview = describeActionPreview(createAction, '2026-09-27');

    expect(preview.kind).toBe('create');
    expect(preview.heading).toBe('将创建的日程');
    expect(preview.title).toBe('张总会');
    expect(preview.dateText).toContain('明天');
    expect(preview.timeText).toBe('15:00');
    expect(preview.locationText).toBe('会议室 A');
  });

  it('只说了哪一天的日程不显示具体时刻', () => {
    const preview = describeActionPreview(
      { ...createAction, payload: { title: '团建', at: '2026-09-29T00:00:00+08:00' } },
      '2026-09-27',
    );

    expect(preview.timeText).toBeNull();
    expect(preview.dateText).toContain('9 月 29 日');
  });

  it('删除卡片是要删哪一条，一眼能看出来', () => {
    const preview = describeActionPreview(deleteAction, '2026-09-27');

    expect(preview.heading).toBe('将删除的日程');
    expect(preview.title).toBe('张总会');
    expect(preview.destructive).toBe(true);
  });

  it('地图上没有的地点按「详细地址」显示，不假装是地图地点', () => {
    const preview = describeActionPreview(
      { ...createAction, payload: { title: '评审', at: '2026-09-28T15:00:00+08:00', locationDetail: '会议室A' } },
      '2026-09-27',
    );

    expect(preview.locationText).toBeNull();
    expect(preview.detailText).toBe('会议室A');
  });

  it('改日程的卡片显示「原 → 新」，只改标题时不拿原时间凑数', () => {
    const preview = describeActionPreview(
      {
        actionId: 'a3',
        type: 'update_event',
        summary: '修改日程：动员大会 → 时间改为 17:00',
        payload: {
          eventId: 7,
          title: '动员大会',
          at: '2026-09-29T17:00:00+08:00',
          previous: { title: '动员大会', at: '2026-09-29T15:00:00+08:00' },
        },
      },
      '2026-09-27',
    );

    expect(preview.timeText).toBe('17:00');
    expect(preview.beforeText).toContain('15:00');
  });
});

describe('卡片的合并与定位', () => {
  it('同一轮里反复申请创建，只留最新一张', () => {
    const first = card(createAction, 'pending');
    const second = card({ ...createAction, actionId: 'a9', summary: '创建日程：张总会 9/28 16:00' }, 'pending');

    expect(mergeActionCards([first], second.action)).toHaveLength(1);
    expect(mergeActionCards([first], second.action)[0].action.actionId).toBe('a9');
  });

  it('已经确认过的卡片留着（那是发生过的事）', () => {
    const done = card(createAction, 'allowed');
    const next = card({ ...createAction, actionId: 'a9' }, 'pending');

    expect(mergeActionCards([done], next.action)).toHaveLength(2);
  });

  it('改同一条日程的新卡片取代旧的；改另一条则不取代', () => {
    const first = card(deleteAction, 'pending');
    const sameEvent = card({ ...deleteAction, actionId: 'a9' }, 'pending');
    const otherEvent = card(
      { ...deleteAction, actionId: 'a10', payload: { eventId: 99, title: '别的会' } },
      'pending',
    );

    expect(dropSupersededCards([first], sameEvent.action)).toHaveLength(0);
    expect(dropSupersededCards([first], otherEvent.action)).toHaveLength(1);
  });

  it('一次只摆一条：队首是第一条待授权的', () => {
    const cards = [card(createAction, 'allowed'), card(deleteAction, 'pending')];

    expect(headPendingCard(cards)?.action.actionId).toBe('a2');
    expect(headPendingCard([card(createAction, 'allowed')])).toBeNull();
  });

  it('按消息定位卡片：前一条消息里有同 id 的旧卡片时，不能打到旧的上去', () => {
    // 线上真踩过：动作 id 曾经每轮都从 a1 重新开始，于是「拒绝」命中了第一条（已处理）的卡片，
    // 直接 return，用户点什么都没反应。
    const messages = [
      { id: 1, actions: [card(createAction, 'allowed')] },
      { id: 2, actions: [card({ ...createAction, summary: '创建日程：人工智能的课 9/30 15:00' }, 'pending')] },
    ];

    expect(cardInMessage(messages, 1, 'a1')?.status).toBe('allowed');
    expect(cardInMessage(messages, 2, 'a1')?.status).toBe('pending');
  });

  it('处置后改状态，其余卡片不动', () => {
    const cards = [card(createAction, 'pending'), card(deleteAction, 'pending')];
    const after = resolveCard(cards, 'a1', { status: 'allowed' });

    expect(after[0].status).toBe('allowed');
    expect(after[1].status).toBe('pending');
  });

  it('用户没处置就发新消息：还挂着的记成「未处理」', () => {
    const cards = [card(createAction, 'pending'), card(deleteAction, 'allowed')];
    const after = skipPendingCards(cards);

    expect(after[0].status).toBe('skipped');
    expect(after[1].status).toBe('allowed');
  });
});
