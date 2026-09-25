import { describe, expect, it } from 'vitest';

import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_MAX_IMAGES,
  feedbackCategoryLabel,
  feedbackStatusLabel,
  feedbackSubmitError,
} from '../src/domain/feedback';

describe('意见反馈（spec §4.1.9）', () => {
  it('分类取值与文案与服务端枚举一致', () => {
    expect(FEEDBACK_CATEGORIES.map((item) => item.value)).toEqual(['BUG', 'SUGGESTION', 'OTHER']);
    expect(feedbackCategoryLabel('BUG')).toBe('功能异常');
    expect(feedbackCategoryLabel('SUGGESTION')).toBe('体验建议');
    expect(feedbackCategoryLabel('OTHER')).toBe('其他');
  });

  it('用户端只区分待处理与已处理，不展示处理过程', () => {
    expect(feedbackStatusLabel('OPEN')).toBe('待处理');
    expect(feedbackStatusLabel('HANDLED')).toBe('已处理');
  });

  it('内容为空或全是空白就不让提交，并且有长度上限', () => {
    expect(feedbackSubmitError('')).not.toBeNull();
    expect(feedbackSubmitError('   \n ')).not.toBeNull();
    expect(feedbackSubmitError('日历页周末标记不显示')).toBeNull();
    expect(feedbackSubmitError('x'.repeat(2001))).not.toBeNull();
  });

  it('图片数量上限与服务端一致', () => {
    // 服务端 MAX_IMAGES = 9；两边不一致会出现「界面允许选、提交被拒」
    expect(FEEDBACK_MAX_IMAGES).toBe(9);
  });
});
