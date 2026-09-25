import type { ApiClient } from './client';
import type {
  EventDetail,
  EventOccurrence,
  GeoPlace,
  GeoStatus,
  IdentityView,
  OrgEvent,
  SmsLoginResponse,
  Task,
  TokenResponse,
} from './types';

export interface CalendarSummary {
  id: number;
  calendarType: string;
  name: string;
  color: string;
  timezone: string;
  isDefault: boolean;
}

/** 日程的写请求体。新建与编辑共用，避免两边字段漂移（spec §4.1.4）。 */
export interface EventWritePayload {
  title: string;
  startAt: string;
  endAt: string;
  allDay?: boolean;
  timezone?: string;
  rrule?: string | null;
  description?: string | null;
  locationName?: string | null;
  locationAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  poiId?: string | null;
  availability?: string;
  status?: string;
  priority?: string;
  category?: string | null;
  url?: string | null;
  travelTimeMinutes?: number | null;
  /** 编辑重复日程时的生效范围；不传等价于 ALL */
  scope?: 'THIS' | 'FUTURE' | 'ALL';
  occurrenceDate?: string | null;
}

export function createEndpoints(client: ApiClient) {
  return {
    // ------------------------------------------------------------- 认证
    sendSmsCode: (phone: string) =>
      client.post<{ expiresIn: number; debugCode?: string }>(
        '/api/v1/auth/sms/code',
        { phone },
        { skipAuthRetry: true },
      ),
    loginBySms: (phone: string, code: string) =>
      client.post<SmsLoginResponse>('/api/v1/auth/login/sms', { phone, code }, { skipAuthRetry: true }),
    selectIdentity: (selectToken: string, identityId: number, deviceId: string) =>
      client.post<TokenResponse>(
        '/api/v1/auth/identity/select',
        { selectToken, identityId, deviceId },
        { skipAuthRetry: true },
      ),
    switchIdentity: (refreshToken: string, targetIdentityId: number, deviceId: string) =>
      client.post<TokenResponse>('/api/v1/auth/identity/switch', {
        refreshToken,
        targetIdentityId,
        deviceId,
      }),
    refresh: (refreshToken: string, deviceId: string) =>
      client.post<TokenResponse>(
        '/api/v1/auth/token/refresh',
        { refreshToken, deviceId },
        { skipAuthRetry: true },
      ),
    logout: (refreshToken: string) =>
      client.post<void>('/api/v1/auth/logout', { refreshToken }, { skipAuthRetry: true }),
    identities: () => client.get<IdentityView[]>('/api/v1/auth/identities'),
    createPersonalIdentity: (registerToken: string, nickname: string, deviceId: string) =>
      client.post<TokenResponse>(
        '/api/v1/identities/personal',
        { nickname, deviceId },
        { skipAuthRetry: true, headers: { Authorization: `Bearer ${registerToken}` } },
      ),

    // ----------------------------------------------------------- 个人日历
    calendars: () => client.get<CalendarSummary[]>('/api/v1/calendars'),
    eventsInRange: (start: string, end: string) =>
      client.get<EventOccurrence[]>('/api/v1/events', { start, end }),
    /**
     * 创建日程。字段对齐主流系统日历（spec §4.1.4）：
     * 地点是结构化的，坐标由服务端统一标注为 GCJ-02，客户端不传坐标系。
     */
    createEvent: (payload: EventWritePayload) => client.post<unknown>('/api/v1/events', payload),
    eventDetail: (eventId: number) => client.get<EventDetail>(`/api/v1/events/${eventId}`),
    updateEvent: (eventId: number, payload: EventWritePayload) =>
      client.patch<EventDetail>(`/api/v1/events/${eventId}`, payload),
    deleteEvent: (eventId: number, scope?: 'THIS' | 'FUTURE' | 'ALL', occurrenceDate?: string) =>
      client.del<void>(`/api/v1/events/${eventId}`, {
        scope,
        occurrenceDate: occurrenceDate ?? undefined,
      }),

    // ------------------------------------------------------------- 地点
    geoPlaces: (keyword: string, city?: string) =>
      client.get<GeoPlace[]>('/api/v1/geo/places', { keyword, city }),
    geoRegeo: (lat: number, lng: number) =>
      client.get<GeoPlace>('/api/v1/geo/regeo', { lat, lng }),
    geoConfig: () => client.get<GeoStatus>('/api/v1/geo/config'),

    // --------------------------------------------------------------- 待办
    tasks: (status?: string) => client.get<Task[]>('/api/v1/tasks', { status }),
    createTask: (payload: {
      title: string;
      description?: string | null;
      dueAt?: string | null;
      allDay?: boolean;
      priority?: string;
    }) => client.post<Task>('/api/v1/tasks', payload),
    completeTask: (taskId: number, completed: boolean) =>
      client.post<Task>(`/api/v1/tasks/${taskId}/complete`, { completed }),

    // --------------------------------------------------------------- 组织
    orgCurrent: () => client.get<Record<string, unknown>>('/api/v1/org/current'),
    orgEvents: (start: string, end: string) => client.get<OrgEvent[]>('/api/v1/org/events', { start, end }),
    submitReceipt: (eventId: number, status: string, remark?: string) =>
      client.post<OrgEvent>(`/api/v1/org/events/${eventId}/receipt`, { status, remark }),
    markOrgEventRead: (eventId: number) =>
      client.post<void>(`/api/v1/org/events/${eventId}/read`),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
