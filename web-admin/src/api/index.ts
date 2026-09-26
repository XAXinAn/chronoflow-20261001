import { clearSession, currentToken } from '../auth/session';
import { createClient } from './client';
import type {
  Account,
  AdminInfo,
  AdminLoginResponse,
  AuditLog,
  DashboardStats,
  DepartmentNode,
  Feedback,
  ImportBatch,
  OrgEventItem,
  OrgMember,
  OrgSettings,
  Organization,
  ReceiptSummary,
  SystemConfig,
} from './types';

let unauthorizedHandler: (() => void) | null = null;

/** 由 App 注入「跳转登录页」的行为，避免 api 层依赖路由。 */
export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

export const client = createClient({
  getToken: currentToken,
  onUnauthenticated: () => {
    clearSession();
    unauthorizedHandler?.();
  },
});

/**
 * 图片存的是**相对 URL**（spec §5.10：换域名 / 上 CDN 都不用改数据），
 * 展示时按当前 API 地址拼出来。
 */
export function resolveApiAssetUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return `${client.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

export const api = {
  // ---------------------------------------------------------------- 认证
  login: (username: string, password: string) =>
    client.post<AdminLoginResponse>('/api/v1/admin/auth/login', { username, password }),
  me: () => client.get<AdminInfo>('/api/v1/admin/me'),
  changePassword: (oldPassword: string, newPassword: string) =>
    client.put<void>('/api/v1/admin/me/password', { oldPassword, newPassword }),

  // ---------------------------------------------------------------- 组织
  organizations: () => client.get<Organization[]>('/api/v1/admin/organizations'),
  createOrganization: (payload: {
    name: string;
    code: string;
    maxMembers?: number;
    adminUsername: string;
    adminPassword: string;
    adminRealName?: string;
  }) => client.post<Organization>('/api/v1/admin/organizations', payload),
  updateOrganization: (id: number, payload: Record<string, unknown>) =>
    client.patch<Organization>(`/api/v1/admin/organizations/${id}`, payload),
  changeOrganizationStatus: (id: number, status: string) =>
    client.post<Organization>(`/api/v1/admin/organizations/${id}/status`, { status }),
  deleteOrganization: (id: number) => client.del<void>(`/api/v1/admin/organizations/${id}`),

  // ---------------------------------------------------------------- 账号
  accounts: (params: { phone?: string; status?: string; limit?: number }) =>
    client.get<Account[]>('/api/v1/admin/accounts', params),
  changeAccountStatus: (id: number, status: string) =>
    client.post<Account>(`/api/v1/admin/accounts/${id}/status`, { status }),
  changeIdentityStatus: (id: number, status: string) =>
    client.post<void>(`/api/v1/admin/identities/${id}/status`, { status }),
  forceLogout: (id: number) => client.post<void>(`/api/v1/admin/accounts/${id}/force-logout`),

  // ------------------------------------------------------------ 管理员
  admins: () => client.get<AdminInfo[]>('/api/v1/admin/admins'),
  createAdmin: (payload: {
    username: string;
    password: string;
    role: string;
    orgId?: number;
    realName?: string;
  }) => client.post<AdminInfo>('/api/v1/admin/admins', payload),
  updateAdmin: (id: number, payload: Record<string, unknown>) =>
    client.patch<AdminInfo>(`/api/v1/admin/admins/${id}`, payload),
  resetAdminPassword: (id: number, newPassword: string) =>
    client.post<void>(`/api/v1/admin/admins/${id}/reset-password`, { newPassword }),

  // ------------------------------------------------------------ 配置
  configs: () => client.get<SystemConfig[]>('/api/v1/admin/configs'),
  updateConfig: (key: string, configValue: string, description?: string) =>
    client.put<SystemConfig>(`/api/v1/admin/configs/${encodeURIComponent(key)}`, {
      configValue,
      description,
    }),

  // ------------------------------------------------------------ 看板与审计
  dashboard: () => client.get<DashboardStats>('/api/v1/admin/dashboard/stats'),
  auditLogs: (params: { action?: string; actorName?: string; orgId?: number; limit?: number }) =>
    client.get<AuditLog[]>('/api/v1/admin/audit-logs', params),
  exportAuditLogs: (params: { action?: string; actorName?: string; limit?: number } = {}) =>
    client.getText('/api/v1/admin/audit-logs/export', params),

  // ------------------------------------------------------------ 意见反馈（超管，spec §4.4）
  feedbacks: (params: { status?: string; category?: string; limit?: number } = {}) =>
    client.get<Feedback[]>('/api/v1/admin/feedback', params),
  handleFeedback: (id: number) => client.post<Feedback>(`/api/v1/admin/feedback/${id}/handle`),

  // ------------------------------------------------------- 组织管理端（spec §4.3）
  // 这里的所有接口都由「组织管理员」的后台令牌调用：新组织里一个成员都没有时，
  // 这是唯一能建部门、导成员的入口（后端 `/org-admin/**` 认这个令牌）。
  orgSettings: () => client.get<OrgSettings>('/api/v1/org-admin/settings'),
  updateOrgSettings: (payload: {
    name?: string;
    logoUrl?: string;
    contactName?: string;
    contactPhone?: string;
    timezone?: string;
  }) => client.patch<OrgSettings>('/api/v1/org-admin/settings', payload),

  orgMembers: () => client.get<OrgMember[]>('/api/v1/org-admin/members'),
  createOrgMember: (payload: {
    memberKey: string;
    realName: string;
    departmentId: number;
    jobTitle?: string;
    orgRole?: string;
  }) => client.post<OrgMember>('/api/v1/org-admin/members', payload),
  updateOrgMember: (
    id: number,
    payload: {
      realName?: string;
      departmentId?: number;
      memberKey?: string;
      jobTitle?: string;
      orgRole?: string;
      status?: string;
    },
  ) => client.patch<OrgMember>(`/api/v1/org-admin/members/${id}`, payload),
  /** 解绑组织账号：成员换号或被冒领后的恢复路径（spec §3.2） */
  unbindOrgMember: (id: number) => client.post<OrgMember>(`/api/v1/org-admin/members/${id}/unbind`),

  orgDepartments: () => client.get<DepartmentNode[]>('/api/v1/org-admin/departments'),
  createOrgDepartment: (payload: { parentId?: number; name: string; sortOrder?: number }) =>
    client.post<DepartmentNode>('/api/v1/org-admin/departments', payload),
  updateOrgDepartment: (id: number, payload: { name?: string; sortOrder?: number }) =>
    client.patch<DepartmentNode>(`/api/v1/org-admin/departments/${id}`, payload),
  deleteOrgDepartment: (id: number) => client.del<void>(`/api/v1/org-admin/departments/${id}`),
  grantDepartmentManager: (id: number, orgMemberId: number) =>
    client.post<void>(`/api/v1/org-admin/departments/${id}/managers`, { orgMemberId }),
  revokeDepartmentManager: (id: number, orgMemberId: number) =>
    client.del<void>(`/api/v1/org-admin/departments/${id}/managers/${orgMemberId}`),

  orgEvents: (start: string, end: string) =>
    client.get<OrgEventItem[]>('/api/v1/org-admin/events', { start, end }),
  dispatchOrgEvent: (payload: {
    title: string;
    description?: string;
    location?: string;
    startAt: string;
    endAt: string;
    allDay?: boolean;
    timezone?: string;
    scopeType: string;
    departmentId?: number;
    includeSubDepartments?: boolean;
    memberIds?: number[];
    requireReceipt?: boolean;
  }) => client.post<OrgEventItem>('/api/v1/org-admin/events', payload),
  updateOrgEvent: (
    eventId: number,
    payload: { title?: string; location?: string; startAt?: string; endAt?: string; redispatch?: boolean },
  ) => client.patch<OrgEventItem>(`/api/v1/org-admin/events/${eventId}`, payload),
  revokeOrgEvent: (eventId: number) =>
    client.post<void>(`/api/v1/org-admin/events/${eventId}/revoke`),
  deleteOrgEvent: (eventId: number) => client.del<void>(`/api/v1/org-admin/events/${eventId}`),
  orgEventReceipts: (eventId: number) =>
    client.get<ReceiptSummary>(`/api/v1/org-admin/events/${eventId}/receipts`),

  importOrgMembers: (file: File, autoCreateDepartment: boolean) => {
    const form = new FormData();
    form.append('file', file);
    return client.postForm<ImportBatch>(
      `/api/v1/org-admin/members/import?autoCreateDepartment=${autoCreateDepartment}`,
      form,
    );
  },
  orgImports: () => client.get<ImportBatch[]>('/api/v1/org-admin/imports'),
  orgImportDetail: (batchId: number) =>
    client.get<ImportBatch>(`/api/v1/org-admin/imports/${batchId}`),
  orgImportFailures: (batchId: number) =>
    client.getText(`/api/v1/org-admin/imports/${batchId}/failures`),
  orgImportTemplate: () => client.getBlob('/api/v1/org-admin/members/import/template'),

  orgLogs: (params: { action?: string; limit?: number } = {}) =>
    client.get<AuditLog[]>('/api/v1/org-admin/logs', params),
};
