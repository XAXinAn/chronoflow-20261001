import { clearSession, currentToken } from '../auth/session';
import { createClient } from './client';
import type {
  Account,
  AdminInfo,
  AdminLoginResponse,
  AuditLog,
  DashboardStats,
  Organization,
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
};
