import { describe, expect, it } from 'vitest';

import {
  applyResolvedPlace,
  confidenceLabel,
  createdSummary,
  endAtOrDefault,
  splitDrafts,
  type RecognizedEventDraft,
} from '../src/domain/vision';

describe('拍照识别日程（spec §4.1.9）', () => {
  it('有时间建日程，没时间降级成待办——不硬编一个时间', () => {
    const drafts: RecognizedEventDraft[] = [
      { title: '季度技术评审会', startAt: '2026-09-26T15:00:00+08:00' },
      { title: '看板上的待办' },
      { title: '团队晚餐', startAt: '2026-09-26T19:00:00+08:00' },
    ];

    const { events, tasks } = splitDrafts(drafts);

    expect(events.map((item) => item.title)).toEqual(['季度技术评审会', '团队晚餐']);
    expect(tasks.map((item) => item.title)).toEqual(['看板上的待办']);
  });

  it('结束时间缺失时默认 1 小时，而不是留个空区间', () => {
    const end = endAtOrDefault({ title: '会', startAt: '2026-09-26T15:00:00+08:00' });
    expect(new Date(end).getTime() - new Date('2026-09-26T15:00:00+08:00').getTime()).toBe(3600_000);
    // 模型给了结束时间就用它
    expect(endAtOrDefault({ title: '会', startAt: '2026-09-26T15:00:00+08:00', endAt: '2026-09-26T16:30:00+08:00' }))
      .toBe('2026-09-26T16:30:00+08:00');
  });

  it('置信度如实展示：低置信度提示核对，没给就不显示', () => {
    expect(confidenceLabel(0.9)).toBe('识别把握较大');
    expect(confidenceLabel(0.4)).toBe('建议核对');
    expect(confidenceLabel(null)).toBeNull();
    expect(confidenceLabel(undefined)).toBeNull();
  });

  it('创建结果汇总同时报日程与待办', () => {
    expect(createdSummary(2, 1)).toBe('已创建 2 条日程 和 1 条待办');
    expect(createdSummary(1, 0)).toBe('已创建 1 条日程');
    expect(createdSummary(0, 0)).toBe('没有可创建的内容');
  });
});

describe('识别出的地点要能在地图上定位（spec §5.9）', () => {
  it('高德匹配到了就记结构化地点（带坐标，能导航）', () => {
    const resolved = applyResolvedPlace(
      { title: '季度技术评审会', locationName: 'A座3F报告厅' },
      {
        name: 'A座报告厅',
        address: '北京市海淀区某路 1 号',
        latitude: 39.9,
        longitude: 116.4,
        poiId: 'B0001',
      },
    );

    expect(resolved.place?.poiId).toBe('B0001');
    expect(resolved.locationName).toBe('A座报告厅');
    expect(resolved.locationUnmatched).toBe(false);
  });

  it('高德匹配不到就把地点留空，并标明「已留空」——不留导航不了的自由文本', () => {
    const unresolved = applyResolvedPlace(
      { title: '找地方吃饭', locationName: '食堂三楼那个角落' },
      null,
    );

    expect(unresolved.place).toBeNull();
    expect(unresolved.locationUnmatched).toBe(true);
  });

  it('本来就没有地点的条目不该被标成「未匹配」', () => {
    const untouched = applyResolvedPlace({ title: '写周报' }, null);
    expect(untouched.locationUnmatched).toBe(false);
  });
});
