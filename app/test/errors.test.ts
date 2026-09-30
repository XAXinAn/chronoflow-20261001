import { describe, expect, it } from 'vitest';

import { ApiError } from '../src/api/client';
import { userFacingError, userFacingMessage } from '../src/domain/errors';

/**
 * 错误话术（用户视角的界面卫生）。
 *
 * 这一组断言的作用是**防止实现细节漏到界面上**：错误码、HTTP 状态码、
 * 「未接入模型」这类说法一旦出现在用户眼前，用户既看不懂也没法处理。
 */
describe('给用户看的错误话术', () => {
  it('系统 / 第三方不可用（90001、90002）说成「服务暂时不可用」', () => {
    expect(userFacingMessage(90002, '小安还没有接入模型', '兜底')).toBe('服务暂时不可用，请稍后重试');
    expect(userFacingMessage(90001, '服务内部错误', '兜底')).toBe('服务暂时不可用，请稍后重试');
  });

  it('网络类问题（-1）说成「网络不太顺畅」', () => {
    expect(userFacingMessage(-1, '助手响应异常（HTTP 502）', '兜底')).toBe('网络不太顺畅，请稍后重试');
  });

  it('登录态失效要单独说，否则用户会一直重试', () => {
    expect(userFacingMessage(20001, '未登录', '兜底')).toBe('登录已过期，请重新登录');
    expect(userFacingMessage(20002, '登录已过期', '兜底')).toBe('登录已过期，请重新登录');
  });

  it('业务语义明确的报错原样保留（用户能据此改变行为）', () => {
    expect(userFacingMessage(20006, '验证码错误或已失效', '兜底')).toBe('验证码错误或已失效');
    expect(userFacingMessage(20003, '组织下发的日程要联系发起人处理', '兜底'))
      .toBe('组织下发的日程要联系发起人处理');
  });

  it('没有文案时用兜底，不显示错误码', () => {
    expect(userFacingMessage(30001, '', '保存失败')).toBe('保存失败');
    expect(userFacingMessage(undefined, undefined, '保存失败')).toBe('保存失败');
  });

  it('非 ApiError（原生异常等）一律用兜底', () => {
    expect(userFacingError(new Error('Cannot read property x of undefined'), '操作失败')).toBe('操作失败');
    expect(userFacingError(new ApiError(20006, '验证码错误或已失效'), '操作失败')).toBe('验证码错误或已失效');
  });
});
