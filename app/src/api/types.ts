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
  location: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  timezone: string;
  recurring: boolean;
  occurrenceDate: string | null;
  modified: boolean;
}

export interface Task {
  id: number;
  calendarId: number;
  parentTaskId: number | null;
  title: string;
  description: string | null;
  dueAt: string | null;
  allDay: boolean;
  status: 'TODO' | 'DONE' | 'CANCELLED';
  completedAt: string | null;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
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
