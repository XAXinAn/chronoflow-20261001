import type { AgentApprovalPayload } from './agent';
import type { ApiClient } from './client';
import type { AppRelease } from './appRelease';
import { File } from 'expo-file-system';
import type {
  EventDetail,
  EventOccurrence,
  FeedbackCategory,
  FeedbackItem,
  GeoPlace,
  GeoStatus,
  HolidayResponse,
  IdentityView,
  OrgAccount,
  OrgAccountLoginResult,
  OrgCurrent,
  OrgDepartmentNode,
  OrgDispatchRequest,
  OrgEvent,
  OrgMemberItem,
  ReminderScheduleEntry,
  SearchResultItem,
  SmsLoginResponse,
  SystemInfo,
  Task,
  TokenResponse,
  UploadedImage,
  ParsedEventItem,
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
  /** 日程只有一个时间点（spec §4.1.2）；只说哪天的给当天 00:00 */
  at: string;
  timezone?: string;
  rrule?: string | null;
  description?: string | null;
  locationName?: string | null;
  locationAddress?: string | null;
  locationDetail?: string | null;
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

/** 待办的写请求体。新建与编辑共用。 */
export interface TaskWritePayload {
  title: string;
  description?: string | null;
  /** 关联的日程 id；null 表示不修改 */
  eventId?: number | null;
  /** 显式解除日程关联（null 在 PATCH 里表示「不修改」） */
  clearEvent?: boolean;
  dueAt?: string | null;
  /**
   * 显式清空截止时间。
   *
   * 服务端 PATCH 里 null 表示「不修改」，所以「改回待安排」必须靠这个开关表达，
   * 否则用户设过截止时间后就再也去不掉了。
   */
  clearDueAt?: boolean;
  priority?: string;
  status?: string;
  /** 重复规则 RRULE；空串表示「不重复」（服务端把空白一律存成 null） */
  rrule?: string | null;
}

export function createEndpoints(client: ApiClient) {
  return {
    /**
     * 授权答复：写工具在对话流里**阻塞等这个答复**，答复进来它才继续跑。
     * 所以这条请求要能在流还没结束时发出去。
     */
    approveAgentAction: (payload: AgentApprovalPayload) =>
      client.post<void>('/api/v1/ai/agent/approvals', payload),

    // ------------------------------------------------------------- 认证
    sendSmsCode: (phone: string) =>
      client.post<{ expiresIn: number; debugCode?: string }>(
        '/api/v1/auth/sms/code',
        { phone },
        { skipAuthRetry: true },
      ),
    /** 登录只认个人账号：已有个人身份时直接返回它的令牌对（spec §3.2）。 */
    loginBySms: (phone: string, code: string, deviceId: string) =>
      client.post<SmsLoginResponse>(
        '/api/v1/auth/login/sms',
        { phone, code, deviceId },
        { skipAuthRetry: true },
      ),
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

    /** 当前身份信息（含 avatarUrl）。头像这类身份级属性以服务端为准，不只靠本地会话缓存。 */
    me: () => client.get<IdentityView>('/api/v1/me'),
    /** 更新昵称 / 头像 / 时区（spec §4.1.8）。avatarUrl 传上传通道返回的相对 URL。 */
    updateMe: (payload: { nickname?: string; avatarUrl?: string | null; timezone?: string }) =>
      client.patch<IdentityView>('/api/v1/me', payload),

    // ----------------------------------------------------- 账号与安全（实名 / 邮箱）
    /** 「账号与安全」页的当前状态：邮箱 / 是否已验证 / 是否已实名（spec §6.2）。 */
    meSecurity: () =>
      client.get<{ email: string | null; emailVerified: boolean; realNameVerified: boolean; realName: string | null }>(
        '/api/v1/me/security',
      ),
    /**
     * 给要绑定的邮箱发验证码（阿里云 DirectMail）。
     *
     * <p>与短信一样返回 `expiresIn`；`debugCode` 只在**未接真实邮件通道**的开发环境出现，
     * 生产环境这个字段不存在（服务端有自检，接真通道后永不回显）。
     */
    sendEmailCode: (email: string) =>
      client.post<{ expiresIn: number; debugCode?: string }>('/api/v1/me/email/code', { email }),
    /** 绑定 / 改绑邮箱：带上刚收到的验证码（邮箱已被别的账号占用会被拒）。 */
    bindEmail: (payload: { email: string; code: string }) =>
      client.post<IdentityView>('/api/v1/me/email', payload),
    /**
     * 开始实名认证（阿里云 CloudAuth，ID_PRO：姓名 + 身份证 + 活体）。
     *
     * <p>服务端**不接收也不回传身份证号**：先由 App 把姓名/身份证交给服务端换 `certifyUrl`，
     * 再用 WebView 打开它做人脸。服务未配置时返回 90002 一类的错误，界面如实说「暂不可用」。
     */
    initRealName: (payload: { realName: string; idCardNumber: string; metaInfo: string }) =>
      client.post<{ certifyId: string; certifyUrl: string }>('/api/v1/me/realname', payload),
    /** 查实名结果：人脸做完后轮询这个（服务端调 DescribeFaceVerify）。 */
    realNameResult: (certifyId: string) =>
      client.get<{ verified: boolean; message?: string | null }>(
        '/api/v1/me/realname/result',
        { certifyId },
      ),

    /**
     * 自助注销账号（商店规范 §2.7：App 内必须有对应的注销功能按钮）。
     *
     * 服务端会立即吊销全部令牌并删除/匿名化个人信息，因此调用方拿到成功响应后
     * **必须**清掉本地会话（见 AccountDeletionScreen）。
     */
    deleteAccount: () => client.post<void>('/api/v1/me/deletion', {}),

    /**
     * 批量覆盖某个日程/待办的提醒设置（spec §6.2 的 `PUT /reminders`，语义是整体覆盖）。
     *
     * 服务端存一份是为了「换设备/重装后还能把提醒排回来」，真正的到点触发由 App 本地通知负责
     * （spec §4.5：到点提醒不经过服务端推送）。
     */
    setReminders: (payload: {
      targetType: 'EVENT' | 'TASK';
      targetId: number;
      /**
       * 字段名是 `items`（两版后端的 DTO 都是这个），**不是** `reminders`。
       *
       * 这里踩过一次：客户端按「语义好看」写成 `reminders`，而后端要 `items`，
       * 结果保存提醒必然 10001「items 不能为空」。因为 App 是第一个真正调用这个接口的地方，
       * 两版后端的测试都只测了 `items`，谁都没发现 —— 真机第一次点保存才暴露。
       */
      items: { minutesBefore: number }[];
    }) => client.put<{ minutesBefore: number }[]>('/api/v1/reminders', payload),

    reminders: (targetType: 'EVENT' | 'TASK', targetId: number) =>
      client.get<{ minutesBefore: number }[]>('/api/v1/reminders', {
        targetType,
        targetId: String(targetId),
      }),

    /**
     * 未来一段时间内所有要响的提醒（含重复日程展开后的每一次出现）。
     *
     * App 冷启动 / 回到前台时用它把本机通知重排一遍：重复日程在客户端只拿得到 RRULE 字符串，
     * 展开留给服务端做（spec §4.5）。
     */
    reminderSchedule: (start: string, end: string) =>
      client.get<ReminderScheduleEntry[]>('/api/v1/reminders/schedule', { start, end }),

    // ----------------------------------------------------------- 个人日历
    calendars: () => client.get<CalendarSummary[]>('/api/v1/calendars'),
    eventsInRange: (start: string, end: string) =>
      client.get<EventOccurrence[]>('/api/v1/events', { start, end }),
    /**
     * 我的**全部日程**（每个重复序列只出现一次），按时间倒序，可按关键字搜。
     *
     * 「待办 → 关联日程」的候选列表用它（spec §4.1.6）：候选不受时间窗口限制
     * ——「上个月那个会」也可能要挂一条待办上去 —— 并且列表长了必须能搜。
     */
    allEvents: (keyword?: string) =>
      client.get<EventOccurrence[]>('/api/v1/events/all', { keyword: keyword ?? undefined }),
    /**
     * 创建日程。字段对齐主流系统日历（spec §4.1.4）：
     * 地点是结构化的，坐标由服务端统一标注为 GCJ-02，客户端不传坐标系。
     */
    /**
     * 创建日程。返回的就是日程详情（POST 与 GET /events/{id} 同一个 `EventResponse`），
     * 所以拿得到 `id` —— 紧接着要按这个 id 存提醒（`PUT /reminders`）。
     */
    createEvent: (payload: EventWritePayload) => client.post<EventDetail>('/api/v1/events', payload),
    eventDetail: (eventId: number) => client.get<EventDetail>(`/api/v1/events/${eventId}`),
    /**
     * 编辑日程。PATCH 的语义是「只改给到的字段」，所以这里收的是**部分**字段：
     * 助手改一条日程时只会带上真正要改的那几项（不传的字段保持原样）。
     */
    updateEvent: (eventId: number, payload: Partial<EventWritePayload>) =>
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
    createTask: (payload: TaskWritePayload) => client.post<Task>('/api/v1/tasks', payload),
    taskDetail: (taskId: number) => client.get<Task>(`/api/v1/tasks/${taskId}`),
    updateTask: (taskId: number, payload: TaskWritePayload) =>
      client.patch<Task>(`/api/v1/tasks/${taskId}`, payload),
    deleteTask: (taskId: number) => client.del<void>(`/api/v1/tasks/${taskId}`),
    completeTask: (taskId: number, completed: boolean) =>
      client.post<Task>(`/api/v1/tasks/${taskId}/complete`, { completed }),

    // ----------------------------------------------------- 检索与节假日
    /**
     * 跨日程与待办的检索。**服务端全量检索**，不传月份——否则「上个月那个会」永远搜不到。
     */
    search: (keyword: string, types?: string, limit?: number) =>
      client.get<SearchResultItem[]>('/api/v1/search', { keyword, types, limit }),
    /**
     * 节假日与调休。省略 month 取全年：日历网格会带出相邻月份的格子，
     * 按年取一次比按月取更适合翻月场景。
     */
    holidays: (year: number, month?: number, country?: string) =>
      client.get<HolidayResponse>('/api/v1/holidays', { year, month, country }),

    // ------------------------------------------------------- 上传与反馈
    /**
     * 上传本地图片（spec §5.10）。
     *
     * <p>这里必须用 expo-file-system 的 File，不能写 RN 那套 `{ uri, name, type }`：
     * Expo SDK 57 的 fetch 自己拼 multipart，只接受 **Blob 或带 bytes() 的文件对象**，
     * 传 `{ uri, ... }` 会直接抛 `Unsupported FormDataPart implementation`（实测踩过）。
     * File 正好实现 Blob 接口，并自带 name / type。
     */
    uploadImage: (uri: string) => {
      const form = new FormData();
      form.append('file', new File(uri) as unknown as Blob);
      return client.upload<UploadedImage>('/api/v1/uploads/images', form);
    },
    /**
     * OCR 文字 → 日程草稿（spec §4.1.9）。
     *
     * <p>**图片不出手机**：这里只把手机端 OCR（PaddleOCR PP-OCRv4，见 `vision/`）出来的**文字**发上去，
     * 由服务端模型负责「一段通知里有几件事、哪句是时间」。
     * `items[].at` 可能是空的（通知里没写日期），交给确认页让用户补；
     * 解析模型未配置时返回 90002，界面如实说明，不假装识别成功。
     */
    parseScheduleText: (payload: { text: string; today: string; timezone: string }) =>
      client.post<{ items: ParsedEventItem[] }>('/api/v1/ai/events/parse-text', payload),
    /**
     * 系统元信息（免登录）。App 用它判断「小安」有没有接入模型（aiAgentEnabled），
     * 避免界面看起来能用、点了却装死（spec §11 阶段三）。
     */
    systemInfo: () => client.get<SystemInfo>('/api/v1/system/info'),
    /**
     * 应用内更新：拿服务端配置的最新版本信息（spec §4.1.11）。**免登录**——
     * 登录接口改坏时，老客户端还得能查到新版本把自己升级上去。
     * 没配置发布信息的部署会回 `versionCode: 0`，调用方据此认为「没有更新」。
     */
    appRelease: () => client.get<AppRelease>('/api/v1/system/app-release'),
    /**
     * 语音转文字（spec §11 阶段三）。录音上限 60 秒；音频只在服务端内存里转 base64
     * 转发给百炼，**不落盘**。返回的文本由 App 填进输入框，不自动发送。
     */
    transcribe: (uri: string) => {
      const form = new FormData();
      form.append('file', new File(uri) as unknown as Blob);
      return client.upload<{ text: string; language: string | null }>('/api/v1/ai/transcribe', form);
    },
    /** 提交意见反馈（spec §4.1.9）。images 是上传通道返回的相对 URL 数组。 */
    submitFeedback: (payload: {
      category: FeedbackCategory;
      content: string;
      images?: string[];
    }) => client.post<FeedbackItem>('/api/v1/feedback', payload),
    /** 我提交过的反馈；用户端不展示处理过程，只用来回看自己提过什么。 */
    myFeedback: () => client.get<FeedbackItem[]>('/api/v1/feedback'),

    // --------------------------------------------------------- 组织账号
    /** 登录组织账号并绑定（spec §3.2）：组织唯一 ID + 成员唯一识别 ID。 */
    claimOrgAccount: (org: string, memberKey: string, deviceId: string) =>
      client.post<OrgAccountLoginResult>(
        `/api/v1/org-accounts/login?deviceId=${encodeURIComponent(deviceId)}`,
        { org, memberKey },
      ),
    /** 我绑定过的组织账号列表。 */
    orgAccounts: () => client.get<OrgAccount[]>('/api/v1/org-accounts'),
    /** 解绑（删除登录记录）：组织侧成员记录保留，可重新认领。 */
    unlinkOrgAccount: (identityId: number) => client.del<void>(`/api/v1/org-accounts/${identityId}`),

    // ------------------------------------------------------------- 拍照识别
    // --------------------------------------------------------------- 组织
    orgCurrent: () => client.get<OrgCurrent>('/api/v1/org/current'),
    /** 组织部门树（成员可见）；管理端页面对它按可管理范围过滤。 */
    orgDepartments: () => client.get<OrgDepartmentNode[]>('/api/v1/org/departments/tree'),
    /** 成员列表；服务端按调用者的部门范围收敛，所以部门管理员只拿得到自己范围内的人。 */
    orgMembers: (departmentId?: number) =>
      client.get<OrgMemberItem[]>('/api/v1/org/members', { departmentId }),
    orgEvents: (start: string, end: string) => client.get<OrgEvent[]>('/api/v1/org/events', { start, end }),
    /**
     * 下发组织日程（spec §4.2.2）。
     *
     * 走的是 `/org-admin/events`：这个前缀同时接受后台组织管理员的 ADMIN 令牌与
     * App 里组织身份的 ACCESS 令牌，两条入口权限口径一致（spec §3.2 / §6.3）。
     */
    dispatchOrgEvent: (payload: OrgDispatchRequest) =>
      client.post<OrgEvent>('/api/v1/org-admin/events', payload),
    /** 改组织日程：只有发起人本人能改（spec §4.2.2），服务端会拦其他人。 */
    updateOrgEvent: (
      eventId: number,
      payload: {
        title?: string;
        description?: string;
        location?: string;
        at?: string;
        timezone?: string;
      },
    ) => client.patch<OrgEvent>(`/api/v1/org-admin/events/${eventId}`, payload),
    /** 删组织日程（软删 + 下发记录置为已撤回）；同样只有发起人能删。 */
    deleteOrgEvent: (eventId: number) =>
      client.del<void>(`/api/v1/org-admin/events/${eventId}`),
    /** 撤回下发：成员端随即不再展示；管理端带 `includeRevoked` 仍能翻到这条历史（spec §4.2.2）。 */
    revokeOrgEvent: (eventId: number) =>
      client.post<void>(`/api/v1/org-admin/events/${eventId}/revoke`),
    markOrgEventRead: (eventId: number) =>
      client.post<void>(`/api/v1/org/events/${eventId}/read`),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
