import { ApiError } from '../api/client';

/**
 * 错误 → 给用户看的一句话。
 *
 * <p>原则：**内部错误码、HTTP 状态码、"未配置" 这类实现细节一律不露给用户**。
 * 它们既不可行动（用户能做什么？去改后端配置吗），又显得产品没做完。
 * 用户需要的是「现在该怎么办」。
 *
 * <p>反过来，**业务语义明确**的报错要原样保留——「验证码错误」「该手机号已注册」
 * 「组织下发的日程要联系发起人」，这些是用户能据此改变行为的。
 */

export const NETWORK_ERROR_NOTICE = '网络不太顺畅，请稍后重试';
export const SERVER_ERROR_NOTICE = '服务暂时不可用，请稍后重试';
export const SESSION_EXPIRED_NOTICE = '登录已过期，请重新登录';

/** 与后端错误码分段的约定见 spec §6.1：9xxxx = 系统 / 第三方不可用。 */
const INTERNAL_CODES = new Set([90001, 90002]);
/** -1 是客户端自造的：网络不通、响应不是 JSON、流中断。 */
const NETWORK_CODE = -1;

export function userFacingMessage(
  code: number | null | undefined,
  message: string | null | undefined,
  fallback: string,
): string {
  if (code === NETWORK_CODE) {
    return NETWORK_ERROR_NOTICE;
  }
  if (code === 20001 || code === 20002) {
    return SESSION_EXPIRED_NOTICE;
  }
  if (code !== null && code !== undefined && INTERNAL_CODES.has(code)) {
    return SERVER_ERROR_NOTICE;
  }
  const text = message?.trim();
  return text ? text : fallback;
}

/** 同上，但直接吃异常对象（页面里最常见的写法）。非 ApiError 一律用 fallback。 */
export function userFacingError(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    return userFacingMessage(cause.code, cause.message, fallback);
  }
  return fallback;
}
