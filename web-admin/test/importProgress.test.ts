import { describe, expect, it } from 'vitest';

import { describeImportProgress } from '../src/pages/importProgress';

const T0 = 1_700_000_000_000;

describe('批量导入进度展示', () => {
  it('处理中：给出已处理条数、百分比与预计剩余时间', () => {
    const view = describeImportProgress(
      { status: 'PROCESSING', totalCount: 100, successCount: 20, failCount: 5 },
      T0 + 25_000,
      T0,
    );
    expect(view.running).toBe(true);
    expect(view.processed).toBe(25);
    expect(view.percent).toBe(25);
    expect(view.statusText).toContain('已处理 25 / 100');
    // 25 行 / 25 秒 → 每行 1 秒 → 还剩 75 行 ≈ 75 秒（超一分钟按分钟报）
    expect(view.etaText).toBe('预计还需约 2 分钟');
  });

  it('提交后立刻查看时不编造预计时间（样本太少）', () => {
    const view = describeImportProgress(
      { status: 'PROCESSING', totalCount: 100, successCount: 1, failCount: 0 },
      T0 + 800,
      T0,
    );
    expect(view.etaText).toBe('');
  });

  it('跑完：停止轮询并如实汇总成功与失败', () => {
    const view = describeImportProgress(
      { status: 'PARTIAL_FAILED', totalCount: 3, successCount: 2, failCount: 1 },
      T0 + 5_000,
      T0,
    );
    expect(view.running).toBe(false);
    expect(view.percent).toBe(100);
    expect(view.etaText).toBe('');
    expect(view.statusText).toContain('共 3 行，成功 2，失败 1');
  });

  it('空文件不会算出 0 除', () => {
    const view = describeImportProgress(
      { status: 'SUCCESS', totalCount: 0, successCount: 0, failCount: 0 },
      T0,
      null,
    );
    expect(view.percent).toBe(100);
    expect(view.etaText).toBe('');
  });
});
