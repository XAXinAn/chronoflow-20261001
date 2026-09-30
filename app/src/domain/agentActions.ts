import { daysBetween, formatEventTime, localDateKey } from './agenda';
import { APP_TIMEZONE } from './calendar';
import type { AgentAction, AgentActionPayload } from './agentStream';

/**
 * 确认卡片上那个按钮到底调哪个接口（spec §11 阶段三）。
 *
 * <p>**写操作由服务端在 agent 循环里执行**（mewcode 的权限层）：写工具先发一条授权请求、
 * 阻塞等用户答复，允许才真正落库（走的是与 REST 同一套 Service），拒绝则写一条
 * 「什么都没改」的工具结果。App 这边只负责把答复送回去，不再自己调 REST。
 *
 * <p>把「动作 → 接口」这段映射放进纯逻辑层，是因为它有三个必须钉死的点：
 * ① 确认后确实调的是这条接口；② 组织日程绝不执行；③ 失败要说清原因而不是静默。
 */

/**
 * 一张授权卡片。
 *
 * <p>状态跟 Codex 的授权流程一致：**一次只处理一条**，允许 / 拒绝都留在对话里当记录，
 * 用户没处置就发新消息的记成「未处理」。
 */
export interface AgentActionCard {
  action: AgentAction;
  status: 'pending' | 'running' | 'allowed' | 'denied' | 'failed' | 'skipped';
  error?: string;
  eventId?: number | null;
}

export interface AgentActionPreview {
  kind: 'create' | 'delete' | 'update' | 'unknown';
  /** 卡片抬头：将创建的日程 / 将删除的日程 */
  heading: string;
  title: string;
  /** 9 月 28 日 周一（今天 / 明天的会带上相对说法） */
  dateText: string | null;
  /** 15:00；只说了哪一天时为 null（界面只显示日期） */
  timeText: string | null;
  /** 地图上的地点：`西湖 · 杭州市西湖区龙井路1号` */
  locationText: string | null;
  /** 地图定位不到的详细地址（会议室A / 3 号楼 305），与 locationText 互斥 */
  detailText: string | null;
  /** 修改类动作：改之前的时间（只在真的变了才有），用来显示「原 → 新」 */
 noteText: string | null;
  beforeText: string | null;
  destructive: boolean;
}

export function describeActionPreview(action: AgentAction, todayKey: string): AgentActionPreview {
  const payload: AgentActionPayload = action.payload ?? {};
  const kind = isCreateAction(action)
    ? 'create'
    : isDeleteAction(action)
      ? 'delete'
      : isUpdateAction(action)
        ? 'update'
        : 'unknown';
  const previous = payload.previous ?? null;
  /**
   * 修改类动作只带「改动的字段」：没给时间的改动要沿用原值显示，
   * 否则卡片上会是一片空白，用户根本看不出这条日程是什么。
   */
  const at = payload.at ?? previous?.at ?? null;
  const placeName = (payload.locationName ?? previous?.locationName ?? '').trim();
  const placeAddress = (payload.locationAddress ?? '').trim();
  const detail = (payload.locationDetail ?? '').trim();
  const dateKey = at ? localDateKey(at, APP_TIMEZONE) : null;
  const timeText = at ? formatEventTime(at, APP_TIMEZONE) : null;
  // 时间真的变了才显示「原」那一行：只改标题时把它摆出来是噪音
  const beforeText =
    previous?.at && previous.at !== at
      ? [describeDate(localDateKey(previous.at, APP_TIMEZONE), todayKey),
        formatEventTime(previous.at, APP_TIMEZONE)]
        .filter(Boolean)
        .join(' · ')
      : null;

  return {
    kind,
    heading:
      kind === 'create'
        ? '将创建的日程'
        : kind === 'delete'
          ? '将删除的日程'
          : kind === 'update'
            ? '将修改的日程'
            : '待确认的操作',
    title: (payload.title ?? previous?.title ?? '').trim() || action.summary || '未命名',
    dateText: dateKey ? describeDate(dateKey, todayKey) : null,
    timeText,
    // 地点与详细地址是两层（spec §5.9）：有地图地点就显示「名称 · 地址」，
    // 只有手写内容时按「详细地址」显示 —— 别把「会议室A」说成地图上的地点
    locationText: placeName ? [placeName, placeAddress].filter(Boolean).join(' · ') : null,
    detailText: !placeName && detail ? detail : null,
    noteText: (payload.description ?? '').trim() || null,
    beforeText,
    destructive: kind === 'delete',
  };
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 卡片上的日期：`明天 · 9 月 28 日 周一`。
 *
 * <p>相对说法（今天 / 明天）让人一眼确认「是不是这一天」，绝对日期加上星期
 * 则避免用户在半周以外的时间里数错天。
 */
function describeDate(dateKey: string, todayKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const base = `${month} 月 ${day} 日 ${weekday}`;
  const diff = daysBetween(todayKey, dateKey);
  const relative = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : null;
  return relative ? `${relative} · ${base}` : base;
}

/**
 * 新卡片进来时怎么合。
 *
 * <p>用户说「改成下午四点」以后，模型会重新生成一张卡片 —— 这时候**旧的必须消失**，
 * 否则对话区同时挂着「15:00」和「16:00」两张卡片，用户点哪一个都可能建错。
 * 已经确认过的卡片则要留着：那是发生过的事，不能被后来的卡片抹掉。
 */
export function mergeActionCards(
  cards: AgentActionCard[],
  incoming: AgentAction,
): AgentActionCard[] {
  return [...dropSupersededCards(cards, incoming), { action: incoming, status: 'pending' }];
}

/**
 * 把「被新卡片取代的旧卡片」摘掉（保留已经确认 / 已失败的）。
 *
 * <p>新卡片常常出现在**另一条助手消息**里（用户接着说「改成四点」，那是新的一轮），
 * 所以这条规则要能跨消息使用：同一时间、同一类动作，对话区只该有一张待确认的卡片。
 */
export function dropSupersededCards(
  cards: AgentActionCard[],
  incoming: AgentAction,
): AgentActionCard[] {
  return cards.filter(
    (card) => card.status !== 'pending' || !isSupersededBy(card.action, incoming),
  );
}

/**
 * 新卡片是否取代了旧卡片。
 *
 * <p>建日程按**类型**取代（同一轮里反复调 create 只该留最新一张）；
 * 改 / 删则要按**具体哪一条日程**取代——用户先说要改 A 又说要改 B，
 * 那是两件事，不能把 A 的卡片一起抹掉。
 */
function isSupersededBy(existing: AgentAction, incoming: AgentAction): boolean {
  if (existing.type !== incoming.type) {
    return false;
  }
  if (incoming.type === 'update_event' || incoming.type === 'delete_event') {
    return existing.payload?.eventId === incoming.payload?.eventId;
  }
  return true;
}

/**
 * 下一轮请求要带上的「未确认卡片」。
 *
 * <p>带上它，模型才知道用户说「改成四点」改的是哪一张（卡片正文不在对话历史里）。
 * 只为 idle 的卡片带上：已确认 / 已失败的不该再让模型去改。
 */
/** 队首那条待授权的请求；没有就返回 null。 */
export function headPendingCard(cards: AgentActionCard[]): AgentActionCard | null {
  return cards.find((card) => card.status === 'pending') ?? null;
}

/**
 * 在**指定的那条消息**里找这张授权卡片。
 *
 * <p>为什么不能跨消息按 actionId 找：动作 id 由服务端生成，历史上每轮都从 `a1` 重新开始，
 * 于是对话里可能有两条 id 相同的卡片（前一条已允许、后一条待处理）。全局查找会命中前一条，
 * 一看状态不是 pending 就直接返回 —— 用户点「拒绝」毫无反应（2026-09-29 实测）。
 * 服务端现在改成全局唯一 id 了，这里仍然按消息定位，双保险。
 */
export function cardInMessage(
  messages: { id: number; actions: AgentActionCard[] }[],
  messageId: number,
  actionId: string,
): AgentActionCard | undefined {
  const message = messages.find((item) => item.id === messageId);
  return message?.actions.find((card) => card.action.actionId === actionId);
}

/** 把某条的状态改成新的（其余不动）。 */
/**
 * 用户没处置就发了新消息：把还挂着的授权记为「未处理」。
 *
 * <p>新流程里授权是服务端在流里阻塞等的，输入框会被授权面板顶掉，正常走不到这里；
 * 留着是兜底（比如流已经断了）。
 */
export function skipPendingCards(cards: AgentActionCard[]): AgentActionCard[] {
  return cards.map((card) =>
    card.status === 'pending' ? { ...card, status: 'skipped' as const } : card,
  );
}

export function resolveCard(
  cards: AgentActionCard[],
  actionId: string,
  patch: Partial<AgentActionCard>,
): AgentActionCard[] {
  return cards.map((card) =>
    card.action.actionId === actionId ? { ...card, ...patch } : card,
  );
}

/**
 * 用户没处置就发了新消息：把还挂着的授权记为「未处理」。
 *
 * <p>这样模型下一轮会知道"那条没被允许"，不会以为它还在等确认，
 * 也不会在用户已经转向别的话题时继续追问。
 */
export function isCreateAction(action: AgentAction): boolean {
  return action.type === 'create_event';
}

export function isDeleteAction(action: AgentAction): boolean {
  return action.type === 'delete_event';
}

export function isUpdateAction(action: AgentAction): boolean {
  return action.type === 'update_event';
}

/** 危险色只给不可逆的动作：删除。改时间是可逆的，别吓得用户不敢点。 */
export function isDestructiveAction(action: AgentAction): boolean {
  return isDeleteAction(action);
}
