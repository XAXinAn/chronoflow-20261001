import type { ApiClient } from './client';
import type {
  EventOccurrence,
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
    createEvent: (payload: {
      title: string;
      startAt: string;
      endAt: string;
      allDay?: boolean;
      timezone?: string;
      location?: string;
      rrule?: string;
    }) => client.post<unknown>('/api/v1/events', payload),

    // --------------------------------------------------------------- 待办
    tasks: (status?: string) => client.get<Task[]>('/api/v1/tasks', { status }),
    createTask: (payload: { title: string; dueAt?: string; priority?: string }) =>
      client.post<Task>('/api/v1/tasks', payload),
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
