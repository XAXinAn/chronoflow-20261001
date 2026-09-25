import type { FeedbackCategory, FeedbackItem } from '../api/types';

/**
 * 意见反馈（spec §4.1.9）。
 *
 * 分类取值与文案、提交前校验放在这里，屏幕组件只负责把状态渲染出来。
 */

export const FEEDBACK_CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: 'BUG', label: '功能异常' },
  { value: 'SUGGESTION', label: '体验建议' },
  { value: 'OTHER', label: '其他' },
];

export function feedbackCategoryLabel(category: FeedbackCategory): string {
  return FEEDBACK_CATEGORIES.find((item) => item.value === category)?.label ?? '其他';
}

export function feedbackStatusLabel(status: FeedbackItem['status']): string {
  // 用户端只提交与查看历史，不展示处理过程（spec §4.1.9），所以只区分两个状态
  return status === 'HANDLED' ? '已处理' : '待处理';
}

/** 单条反馈最多几张图（与服务端 MAX_IMAGES 一致）。 */
export const FEEDBACK_MAX_IMAGES = 9;

/**
 * 提交前校验：返回 null 表示可以提交，否则返回给用户看的原因。
 *
 * 在客户端先挡一道不是为了替代服务端校验，而是为了**别让用户白等一次上传**。
 */
export function feedbackSubmitError(content: string): string | null {
  if (!content.trim()) {
    return '请先描述一下遇到的问题或建议';
  }
  if (content.trim().length > 2000) {
    return '描述最长 2000 个字符';
  }
  return null;
}
