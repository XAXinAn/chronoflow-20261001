export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
  traceId?: string;
}

export interface AdminInfo {
  id: number;
  username: string;
  realName?: string;
  role: 'SUPER_ADMIN' | 'ORG_ADMIN';
  orgId?: number;
  status: 'ACTIVE' | 'DISABLED';
}

export interface AdminLoginResponse {
  accessToken: string;
  expiresIn: number;
  admin: AdminInfo;
}

export type OrgStatus = 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

export interface Organization {
  id: number;
  name: string;
  code: string;
  logoUrl?: string;
  timezone?: string;
  status: OrgStatus;
  maxMembers?: number;
  createdAt?: string;
}

export interface AccountIdentity {
  identityId: number;
  identityType: 'PERSONAL' | 'ORG_MEMBER';
  orgId?: number;
  orgName?: string;
  nickname?: string;
  status: 'ACTIVE' | 'DISABLED';
}

export interface Account {
  accountId: number;
  phone: string;
  email?: string;
  wechatBound?: string;
  status: 'ACTIVE' | 'DISABLED';
  lastLoginAt?: string;
  createdAt?: string;
  identities: AccountIdentity[];
}

export interface SystemConfig {
  configKey: string;
  configValue: string;
  description?: string;
  updatedAt?: string;
}

export interface DashboardStats {
  organizationCount: number;
  activeOrganizationCount: number;
  accountCount: number;
  disabledAccountCount: number;
  orgMemberCount: number;
  personalEventCount: number;
  taskCount: number;
  completedTaskCount: number;
  dispatchCount: number;
  receiptCount: number;
  pendingReceiptCount: number;
}

export interface AuditLog {
  id: number;
  actorType: string;
  actorName?: string;
  orgId?: number;
  action: string;
  targetType?: string;
  targetId?: number;
  detail?: string;
  ip?: string;
  createdAt: string;
}
