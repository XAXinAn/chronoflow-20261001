import { fetch as expoFetch } from 'expo/fetch';

import { createAgentStreamParser, type AgentStreamEvent } from '../domain/agentStream';
import { NETWORK_ERROR_NOTICE, userFacingMessage } from '../domain/errors';
import { ApiError } from './client';

/**
 * 助手对话流的传输层（spec §11 阶段三）。
 *
 * <p>为什么不用 api/client.ts 的 request()：那条路径假设响应是**一个** JSON 信封，
 * 而这里是 text/event-stream —— 数据要边收边解析，不能等整个响应结束。
 *
 * <p>用 expo/fetch 而不是全局 fetch：只有它把响应体暴露成 ReadableStream
 * （response.body.getReader()），RN 自带的 polyfill 会把整个响应缓冲完再给你。
 * 万一某个环境没有 body 流，退回到 XMLHttpRequest 的 onprogress ——
 * 老办法难写但能用，总好过「在有的手机上流式变一次性」。
 */

/**
 * 客户端送回去的一条对话。
 *
 * <p>历史里**助手消息带工具调用、后面跟工具结果**（mewcode `conversation/Message` 的形状）：
 * 服务端据此把「它自己发起的调用 + 结果」原样还原给模型。少了工具调用，
 * 模型会以为那件事没落地、把同一个动作再申请一次。
 */
export interface AgentChatTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** 仅 assistant：这一轮请求调用了哪些工具 */
  toolCalls?: { id: string; name: string; arguments: string }[];
  /** 仅 tool：回应的是哪一个工具调用 */
  toolCallId?: string;
}

export interface AgentChatPayload {
  messages: AgentChatTurn[];
  orgIdentityId?: number | null;
}

/** 用户对一次授权请求的答复（mewcode 的 PermissionReply）。 */
export interface AgentApprovalPayload {
  actionId: string;
  allow: boolean;
  /** 拒绝时顺带说的话，模型会据此换个做法 */
  feedback?: string;
}

export interface StreamAgentChatOptions {
  baseUrl: string;
  token: string | null;
  payload: AgentChatPayload;
  signal?: AbortSignal;
  onEvent: (event: AgentStreamEvent) => void;
}

export async function streamAgentChat(options: StreamAgentChatOptions): Promise<void> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/api/v1/ai/agent/chat`;
  const body = JSON.stringify(options.payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // 带上 application/json：模型没配置时服务端返回的是统一信封（90002），不是流
    Accept: 'text/event-stream, application/json',
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  /**
   * 服务端已经发过 `done` 就说明这条回答完整地到了。
   *
   * <p>之后连接被关掉时，底层流可能报一个错（Expo 的 fetch 在流结束时会这样），
   * 那不是「对话中断」——把已经完整收到的回答旁边挂一条红色报错，用户会以为白问了。
   * 所以「已收到 done」之后的流错误只记日志，不往上抛。
   */
  let finished = false;
  const onEvent = (event: AgentStreamEvent) => {
    if (event.type === 'done' || event.type === 'error') {
      finished = true;
    }
    options.onEvent(event);
  };
  const parser = createAgentStreamParser(onEvent);
  let response: Awaited<ReturnType<typeof expoFetch>>;
  try {
    response = await expoFetch(url, {
      method: 'POST',
      headers,
      body,
      // 与浏览器同形：signal 一断，读取循环也会立刻失败
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    throw new ApiError(-1, '连不上助手服务，请检查网络后重试');
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    // 未接入模型 / 未登录 / 参数不对：都是统一信封，直接当普通接口错误处理
    throw await toApiError(response);
  }

  const stream = response.body;
  if (!stream || typeof stream.getReader !== 'function') {
    await streamWithXhr(url, headers, body, parser.push, options.signal);
    parser.flush();
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        parser.push(decoder.decode(value, { stream: true }));
      }
    }
    parser.push(decoder.decode());
  } catch (error) {
    if (!isAbortError(error) && !finished) {
      // log 而不是 warn：Expo Go 里 warn 会弹黄框盖住界面（那是给开发看的）。
      // 用户那边会看到界面上的错误提示，日志留在 Metro 终端供排查。
      console.log('[agent] 对话流中断', error);
      parser.flush();
      throw new ApiError(-1, NETWORK_ERROR_NOTICE);
    }
    // 正常收尾（服务端已发 done）时就别用 warn：dev 构建会弹一个黄框吓用户一跳，
    // 而且这条信息对使用者毫无意义。留在 Metro 日志里给开发看就够了。
    // 打具体名字与文案：Expo 的 fetch 在流结束时给的错误对象常常没有有效 message，
    // 只打对象在日志里就是一个 [Error]，排查时等于没说。
    // 正常收尾（服务端已发 done）时只记一条日志：用户看到的是完整的回答，不需要任何提示
    console.log('[agent] 流收尾时报错（回答已完整收到，忽略）', error);
  } finally {
    parser.flush();
  }
}

async function toApiError(response: { status: number; text: () => Promise<string> }): Promise<ApiError> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    raw = '';
  }
  /**
   * 网关错误多半是「后端正在升级 / 刚重启」——部署时必然出现几秒。
   * 这时候跟用户说「HTTP 502」等于没说，直接告诉他等几秒再试。
   */
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return new ApiError(-1, '小安暂时不可用，请稍后重试。');
  }
  try {
    const envelope = JSON.parse(raw) as { code?: number; message?: string };
    if (typeof envelope.code === 'number') {
      // 原文只留在 ApiError 里（供上层统一翻译）；页面显示什么由 domain/errors.ts 决定
      return new ApiError(envelope.code, envelope.message || '');
    }
  } catch {
    // 不是 JSON（网关返回的 HTML 错误页之类）：走下面的兜底文案
  }
  return new ApiError(-1, userFacingMessage(-1, null, NETWORK_ERROR_NOTICE));
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: string }).name === 'AbortError'
  );
}

/**
 * 没有 body 流时的退路：用 XMLHttpRequest 的 onprogress 增量取文本。
 *
 * <p>RN 的 XMLHttpRequest 在未设置 responseType 时会陆续填充 responseText，
 * 这是在没有 ReadableStream 的运行时里做流式唯一可行的办法。
 */
function streamWithXhr(
  url: string,
  headers: Record<string, string>,
  body: string,
  onText: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let seen = 0;
    const drain = () => {
      const text = request.responseText ?? '';
      if (text.length > seen) {
        onText(text.slice(seen));
        seen = text.length;
      }
    };
    request.open('POST', url);
    for (const [key, value] of Object.entries(headers)) {
      request.setRequestHeader(key, value);
    }
    request.onprogress = drain;
    request.onload = () => {
      drain();
      resolve();
    };
    request.onerror = () => reject(new ApiError(-1, '对话中断了，请再试一次'));
    request.onabort = () => resolve();
    request.ontimeout = () => reject(new ApiError(-1, '助手响应超时，请再试一次'));
    signal?.addEventListener('abort', () => request.abort());
    request.send(body);
  });
}
