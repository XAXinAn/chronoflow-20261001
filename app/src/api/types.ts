export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
  traceId?: string;
}

export type IdentityType = 'PERSONAL' | 'ORG_MEMBER';

export interface IdentitySummary {
  accountId: number;
  identityId: number;
  identityType: IdentityType;
  orgId: number | null;
  nickname: string | null;
  avatarUrl?: string | null;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  identity: IdentitySummary;
}

export interface IdentityView {
  identityId: number;
  identityType: IdentityType;
  nickname: string | null;
  avatarUrl?: string | null;
  orgId: number | null;
  orgName: string | null;
  departmentName: string | null;
  memberNo: string | null;
  orgRole: string | null;
}

export interface SmsLoginResponse {
  needRegister: boolean;
  registerToken: string | null;
  /**
   * 已有个人身份时直接给出的会话（spec §3.2）。
   *
   * App 只登录个人账号，所以没有「选身份」这一步；组织身份靠认领组织账号产生。
   */
  session: TokenResponse | null;
}

/** 我绑定过的组织账号（GET /org-accounts，spec §4.2.5）。 */
export interface OrgAccount {
  identityId: number;
  orgId: number;
  orgName: string;
  orgCode: string;
  /** 成员唯一识别 ID（学号/工号） */
  memberKey: string;
  realName: string | null;
  departmentName: string | null;
  orgRole: string;
  lastLoginAt?: string | null;
}

/** 认领组织账号的结果：账号视图 + 该组织身份的令牌对。 */
export interface OrgAccountLoginResult {
  account: OrgAccount;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface EventOccurrence {
  eventId: number;
  calendarId: number;
  title: string;
  /** 地点已结构化（spec §5.9）；列表只展示名称，地址留给详情与导航 */
  locationName: string | null;
  locationAddress: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  timezone: string;
  recurring: boolean;
  occurrenceDate: string | null;
  modified: boolean;
}

export type EventAvailability = 'BUSY' | 'FREE';
export type EventStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

/** 日程详情（GET /events/{id}），字段与 spec §4.1.4 的可写字段一一对应。 */
export interface EventDetail {
  id: number;
  calendarId: number;
  title: string;
  description: string | null;
  locationName: string | null;
  locationAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  poiId: string | null;
  coordinateSystem: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  timezone: string;
  rrule: string | null;
  status: EventStatus;
  availability: EventAvailability;
  color: string | null;
  priority: Priority;
  category: string | null;
  url: string | null;
  travelTimeMinutes: number | null;
}

/** 地点服务返回的候选地点。坐标一律是 GCJ-02，由服务端标注。 */
export interface GeoPlace {
  poiId: string | null;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  city: string | null;
  district: string | null;
  provider: string;
}

/** 地点服务状态。degraded 为真时 App 必须明确提示，别让用户误判成网络故障。 */
export interface GeoStatus {
  provider: string;
  configuredProvider: string;
  degraded: boolean;
  degradedReason: string | null;
  /** 高德 Web端(JS API) Key；为 null 表示服务端没配，App 应隐藏「地图选点」 */
  jsApiKey: string | null;
  jsSecurityCode: string | null;
}

export interface Task {
  id: number;
  calendarId: number;
  parentTaskId: number | null;
  /** 关联的日程（spec §4.1.6）：一个日程可关联多个待办，待办至多关联一个日程 */
  eventId: number | null;
  /** 关联日程的标题，由服务端带出，列表直接展示 */
  eventTitle: string | null;
  title: string;
  description: string | null;
  dueAt: string | null;
  allDay: boolean;
  status: 'TODO' | 'DONE' | 'CANCELLED';
  completedAt: string | null;
  priority: Priority;
  sortOrder: number;
}

export type ReceiptStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'COMPLETED';

/**
 * 检索结果条目（GET /search）。
 *
 * 日程与待办共用一条结构、靠 `type` 区分：服务端给的是一份按时间倒序排好的统一结果流，
 * 不是两段各自排序的列表（spec §4.1.7）。
 *
 * 注意：Java 版响应会丢掉值为 null 的字段（`default-property-inclusion: non_null`），
 * 所以这里的可选字段一律兼容 `undefined`。
 */
export interface SearchResultItem {
  /** ORG_EVENT = 组织下发给我的组织日程（只读，点开跳进所属组织） */
  type: 'EVENT' | 'TASK' | 'ORG_EVENT';
  id: number;
  title: string;
  /** 日程开始时间；重复日程给的是最近一次实例 */
  startAt?: string | null;
  endAt?: string | null;
  allDay?: boolean | null;
  timezone?: string | null;
  locationName?: string | null;
  /** 待办截止时间；为空表示「待安排」 */
  dueAt?: string | null;
  status?: string | null;
  priority?: string | null;
  /** 命中重复日程时为 true */
  recurring?: boolean | null;
  /** 命中重复实例的日期；点进去应打开「这一次」而不是整条序列 */
  occurrenceDate?: string | null;
  /** 组织日程所属的组织身份；个人条目为 null。App 用它切到对应组织视图 */
  identityId?: number | null;
  orgId?: number | null;
  orgName?: string | null;
}

/** 节假日与调休中的一天（spec §5.11）。 */
export interface HolidayDay {
  date: string;
  name: string;
  /** HOLIDAY 放假 / WORKDAY 调休上班 */
  dayType: 'HOLIDAY' | 'WORKDAY';
}

export interface HolidayResponse {
  country: string;
  year: number;
  /** 省略 month 时服务端返回全年，此时该字段缺失 */
  month?: number | null;
  days: HolidayDay[];
}

/** 上传通道的返回值（POST /uploads/images，spec §5.10）。 */
export interface UploadedImage {
  /** 相对 URL（如 /uploads/ab12….jpg）；展示时用 absoluteMediaUrl 拼 API 地址 */
  url: string;
  size: number;
  contentType: string;
}

export type FeedbackCategory = 'BUG' | 'SUGGESTION' | 'OTHER';

/** 我提交过的反馈（GET /feedback）。用户端不展示处理过程，所以只需要一个状态。 */
export interface FeedbackItem {
  id: number;
  category: FeedbackCategory;
  content: string;
  images: string[];
  status: 'OPEN' | 'HANDLED';
  createdAt: string;
  handledAt?: string | null;
}

export interface OrgEvent {
  eventId: number;
  dispatchId: number;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  timezone: string;
  rrule: string | null;
  requireReceipt: boolean;
  receiptStatus: ReceiptStatus | null;
  receiptAt: string | null;
  remark: string | null;
  read: boolean;
}
