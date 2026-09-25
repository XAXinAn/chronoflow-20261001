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
  needSelectIdentity: boolean;
  selectToken: string | null;
  identities: IdentityView[];
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
