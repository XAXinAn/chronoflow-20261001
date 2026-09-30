/**
 * 助手流的解析（spec §11 阶段三）。
 *
 * <p>服务端用 SSE 回话：`status`（正在查日程…）、`delta`（正文增量）、
 * `action`（待确认动作）、`done`（收尾 + token 用量），出错时是 `error`。
 *
 * <p>这里是**纯逻辑**：只吃字符串、吐事件，不碰 fetch、不碰 React。
 * 分片是网络层的常态——一次 `read()` 可能只拿到半帧、也可能一次拿到三帧——
 * 这类解析出错的表现是「偶尔丢字」或「偶发乱码」，在真机上极难复现，所以必须能单测。
 */

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AgentActionPayload {
  title?: string;
  /** 日程的唯一时间点 */
  at?: string;
  /** 地图上的地点名称（服务端确认匹配到 POI 时才有） */
  locationName?: string;
  /** POI 的地址，与 locationName 成对出现 */
  locationAddress?: string;
  latitude?: number;
  longitude?: number;
  poiId?: string;
  /**
   * 地图定位不到的**详细地址**（教室 / 门牌 / 会议室这类手写内容）。
   *
   * <p>与 locationName 是两层：助手说「会议室A」时它属于这里，
   * 因为地图上没有这个名字（spec §5.9）。
   */
  locationDetail?: string;
  description?: string;
  eventId?: number;
  /**
   * 修改类动作特有：这条日程**改之前**长什么样。
   *
   * <p>卡片要能看出「改了什么」（原 → 新），否则用户是在盲签一个不可逆的改动。
   */
  previous?: {
    title?: string;
    at?: string;
    locationName?: string;
  };
  /**
   * 只读标记：组织下发的日程由服务端拦在生成动作之前，正常情况下 App 永远收不到这样的卡片。
   * 这里再兜一道，是为了「万一收到了」时也绝不执行（见 domain/agentActions.ts）。
   */
  readOnly?: boolean;
}

export interface AgentAction {
  actionId: string;
  type: string;
  summary: string;
  payload: AgentActionPayload;
}

/**
 * 一行**工具记录**（服务端已生成人话摘要，不是原始 JSON）。
 *
 * <p>为什么要有它：只有一行瞬时的「正在查日程…」时，用户看不到"它到底做了什么"。
 */
export interface AgentToolRow {
  toolCallId: string;
  name: string;
  /** 模型给这个工具的参数（JSON 字符串），回放历史时原样带回服务端 */
  arguments: string;
  /** 工具结果（JSON 字符串）；回放历史时原样带回服务端 —— tool_use 与 tool_result 必须配对 */
  result: string;
  /** 查询类（只读）为 true；写入类由授权行承担确认 */
  readOnly: boolean;
  summary: string;
  detail: string[];
}

export type AgentStreamEvent =
  | { type: 'status'; stage: string; label: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; tool: AgentToolRow }
  | { type: 'action'; action: AgentAction }
  | { type: 'done'; finishReason: string; usage: AgentUsage | null }
  | { type: 'error'; code: number; message: string };

export interface AgentStreamParser {
  /** 喂一段原始文本（可能是半帧）；完整的事件会被立刻回调。 */
  push(chunk: string): void;
  /** 流结束时调用，处理缓冲区里最后那半帧。 */
  flush(): void;
}

interface ParsedFrame {
  event: string;
  data: string;
}

function parseFrame(frame: string): ParsedFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) {
      // 空行与注释行（`: keep-alive`）都跳过
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return { event, data: dataLines.join('\n') };
}

function toEvent(frame: ParsedFrame): AgentStreamEvent | null {
  if (frame.data === '[DONE]') {
    return null;
  }
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(frame.data);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    // 帧本身就不完整或不是 JSON：丢掉这一帧，而不是把乱码渲染到界面上
    return null;
  }

  switch (frame.event) {
    case 'status':
      return {
        type: 'status',
        stage: String(payload.stage ?? ''),
        label: String(payload.label ?? '正在处理…'),
      };
    case 'delta': {
      const text = typeof payload.text === 'string' ? payload.text : '';
      return text ? { type: 'delta', text } : null;
    }
    case 'tool': {
      const summary = typeof payload.summary === 'string' ? payload.summary : '';
      if (!summary) {
        return null;
      }
      return {
        type: 'tool',
        tool: {
          toolCallId: String(payload.toolCallId ?? ''),
          name: String(payload.name ?? ''),
          arguments: typeof payload.arguments === 'string' ? payload.arguments : '{}',
          result: typeof payload.result === 'string' ? payload.result : '',
          readOnly: payload.readOnly === true,
          summary,
          detail: Array.isArray(payload.detail)
            ? (payload.detail as unknown[]).map((line) => String(line))
            : [],
        },
      };
    }
    case 'action': {
      const actionId = String(payload.actionId ?? '');
      const type = String(payload.type ?? '');
      if (!actionId || !type) {
        return null;
      }
      return {
        type: 'action',
        action: {
          actionId,
          type,
          summary: String(payload.summary ?? ''),
          payload: (payload.payload ?? {}) as AgentActionPayload,
        },
      };
    }
    case 'done':
      return {
        type: 'done',
        finishReason: String(payload.finishReason ?? 'stop'),
        usage: readUsage(payload.usage),
      };
    case 'error':
      return {
        type: 'error',
        code: typeof payload.code === 'number' ? payload.code : -1,
        message: String(payload.message ?? '助手暂时不可用'),
      };
    default:
      return null;
  }
}

function readUsage(value: unknown): AgentUsage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const usage = value as Record<string, unknown>;
  return {
    promptTokens: Number(usage.promptTokens ?? 0),
    completionTokens: Number(usage.completionTokens ?? 0),
  };
}

export function createAgentStreamParser(
  onEvent: (event: AgentStreamEvent) => void,
): AgentStreamParser {
  let buffer = '';

  const drain = () => {
    // SSE 的一帧以空行结束；`\r\n\r\n` 在规范化后就是 `\n\n`
    for (;;) {
      const separator = buffer.indexOf('\n\n');
      if (separator === -1) {
        return;
      }
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const parsed = parseFrame(frame);
      const event = parsed ? toEvent(parsed) : null;
      if (event) {
        onEvent(event);
      }
    }
  };

  return {
    push(chunk: string) {
      // 统一换行再拼：跨分片的 `\r` + `\n` 如果不归一化，就永远找不到帧边界
      buffer = (buffer + chunk).replace(/\r\n|\r/g, '\n');
      drain();
    },
    flush() {
      const rest = buffer;
      buffer = '';
      const parsed = parseFrame(rest);
      const event = parsed ? toEvent(parsed) : null;
      if (event) {
        onEvent(event);
      }
    },
  };
}
