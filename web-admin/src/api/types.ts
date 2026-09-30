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

// ------------------------------------------------------------ 组织管理端（spec §4.3）

export interface OrgSettings {
  orgId: number;
  name: string;
  code: string;
  logoUrl?: string;
  contactName?: string;
  contactPhone?: string;
  timezone?: string;
  status: OrgStatus;
  /** 成员上限只读：由平台超管控制，组织侧不能自行上调 */
  maxMembers?: number;
  memberCount: number;
}

export interface OrgMember {
  id: number;
  identityId?: number;
  /** 是否已被某个个人账号认领（认领后成员才能在 App 里看到组织日历） */
  bound: boolean;
  departmentId: number;
  departmentName?: string;
  realName: string;
  memberKey: string;
  jobTitle?: string;
  orgRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  status: 'ACTIVE' | 'DISABLED' | 'LEFT';
  departmentManager: boolean;
}

export interface DepartmentNode {
  id: number;
  parentId?: number;
  name: string;
  level: number;
  path: string;
  sortOrder?: number;
  children?: DepartmentNode[];
}

export interface OrgEventItem {
  eventId: number;
  dispatchId: number;
  title: string;
  description?: string;
  location?: string;
  /** 日程只有一个时间点（spec §4.1.2） */
  at: string;
  timezone: string;
  scopeType: 'ALL' | 'DEPARTMENT' | 'MEMBER';
  departmentId?: number;
  recipientCount: number;
  /** 下发状态：ACTIVE 生效中 / REVOKED 已撤回（只有带 includeRevoked 查历史时才可能出现） */
  status: 'ACTIVE' | 'REVOKED';
  /** 当前身份能不能改 / 撤 / 删：只有发起人为 true（spec §4.2.2），页面据此决定按钮显不显示 */
  canEdit: boolean;
}

export interface ImportRowResult {
  rowNo: number;
  status: 'SUCCESS' | 'FAILED';
  errorMessage?: string;
  createdMemberId?: number;
  rawData?: string;
}

export interface ImportBatch {
  batchId: number;
  fileName: string;
  status: 'PROCESSING' | 'SUCCESS' | 'PARTIAL_FAILED' | 'FAILED';
  totalCount: number;
  successCount: number;
  failCount: number;
  createdAt: string;
  finishedAt?: string;
  rows?: ImportRowResult[];
}

// ------------------------------------------------------------ 意见反馈（spec §4.1.9）

export interface Feedback {
  id: number;
  category: 'BUG' | 'SUGGESTION' | 'OTHER';
  content: string;
  images?: string[];
  status: 'OPEN' | 'HANDLED';
  createdAt: string;
  handledAt?: string;
}
