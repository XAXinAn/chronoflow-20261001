import { SERVER_ERROR_NOTICE, userFacingMessage } from './errors';

/**
 * 智能助手（spec §11 阶段三）。
 *
 * <p>这里只有**文案与错误话术**，真正的对话在 `domain/agentStream.ts`（流式解析）与
 * `api/agent.ts`（传输）里。
 *
 * <p>关于「服务端有没有配模型」：那是部署方的事，**界面不表现**。
 * 没配、上游挂了、超时，对用户来说是同一件事——「小安暂时用不了，稍后再试」，
 * 不需要（也不该）让用户看懂 `90002` 或「未接入模型」这种内部状态。
 */

/** 助手名：跟产品名「时纪流」配套。 */
export const AGENT_NAME = '小安';

/**
 * 能力预告（对应 spec §11 阶段三的三件事）。
 *
 * <p>空态按「豆包式」只放一句说明 + 推荐问法，所以这份清单现在**不在界面上渲染**；
 * 它是能力口径的单一来源：提示词、文案、测试都对着它，改能力时不会只改一处。
 */
export const AGENT_CAPABILITIES = [
  '用一句话建日程，比如「明天下午三点和张总开会」',
  '发现时间冲突，并给出当天的空闲时段',
  '按你说的范围翻找历史日程，也能帮你删掉某条',
] as const;

/** 快捷问法：空着输入框时给四个开头，点一下直接发送。 */
export const AGENT_STARTERS = [
  '明天下午三点和张总开会',
  '我明天有哪些安排',
  '帮我找上个月那个评审会',
  '下周的日程都有哪些',
] as const;

/** 一句话说明（空态用，也让新用户知道这里能做什么）。 */
export const AGENT_TAGLINE = '查日程、建日程、改日程，说一句就行';

/**
 * 把服务端错误码翻译成给用户看的一句话。
 *
 * @param code    业务错误码（90001/90002 = 系统与第三方不可用，20001/20002 = 登录态）
 * @param message 服务端原文；只在**业务语义明确**时沿用（例如「组织日程需要找发起人」）
 */
export function describeAgentError(code: number | null | undefined, message?: string | null): string {
  // 话术与全 App 共用一份：用户不需要知道是我们没配模型、上游 500 还是网络抽风，
  // 「服务暂时不可用，请稍后重试」比任何内部错误码都更有用
  return userFacingMessage(code, message, SERVER_ERROR_NOTICE);
}
