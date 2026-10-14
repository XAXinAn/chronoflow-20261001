import type { ImportBatch } from '../api/types';

/**
 * 批量导入进度的展示口径（纯函数，便于单测）。
 *
 * <p>为什么单独抽出来：导入是异步的，管理端只能靠轮询批次详情。用户反馈的
 * 「一直没反应 / 不知道要等多久」有一半是**界面没告诉他进度**造成的——
 * 进度条、已处理条数、预计剩余时间这三样必须从同一份数据算出来，不能再各写一份。
 */
export interface ImportProgressView {
  /** 已处理行数（成功 + 失败） */
  processed: number;
  total: number;
  /** 0–100，整数 */
  percent: number;
  /** 一句话状态，直接显示在进度条上方 */
  statusText: string;
  /** 「预计还需约 xx」，算不出来就是空串（不显示总比显示错的强） */
  etaText: string;
  /** 还在跑：界面据此决定要不要继续轮询 */
  running: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  SUCCESS: '全部成功',
  PARTIAL_FAILED: '部分失败',
  FAILED: '全部失败',
};

/**
 * @param nowMs    当前时间
 * @param startedMs 批次提交的时间（用于估算速率）；没有就退化成「不显示预计时间」
 */
export function describeImportProgress(
  batch: Pick<ImportBatch, 'status' | 'totalCount' | 'successCount' | 'failCount'>,
  nowMs: number,
  startedMs: number | null,
): ImportProgressView {
  const total = Math.max(batch.totalCount, 0);
  const processed = Math.max(batch.successCount + batch.failCount, 0);
  const running = batch.status === 'PROCESSING';
  const percent = total === 0
    ? (running ? 0 : 100)
    : Math.min(100, Math.round((processed / total) * 100));

  const statusText = running
    ? `正在导入：已处理 ${processed} / ${total} 行`
    : `${STATUS_LABEL[batch.status] ?? batch.status}：共 ${total} 行，成功 ${batch.successCount}，失败 ${batch.failCount}`;

  return { processed, total, percent, statusText, etaText: estimate(processed, total, nowMs, startedMs), running };
}

function estimate(processed: number, total: number, nowMs: number, startedMs: number | null): string {
  if (startedMs === null || processed <= 0 || processed >= total) {
    return '';
  }
  const elapsedMs = nowMs - startedMs;
  // 太短的时间窗算出来的速率没有意义（前几行往往包含建连接的开销），会给出离谱的数字
  if (elapsedMs < 1500) {
    return '';
  }
  const perRowMs = elapsedMs / processed;
  const remainSeconds = Math.ceil((perRowMs * (total - processed)) / 1000);
  if (remainSeconds <= 0) {
    return '';
  }
  if (remainSeconds < 60) {
    return `预计还需约 ${remainSeconds} 秒`;
  }
  return `预计还需约 ${Math.ceil(remainSeconds / 60)} 分钟`;
}
