import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import type { StoredSession } from '../auth/tokenStore';
import {
  createOrgTokenProvider,
  loadOrgAccounts,
  saveOrgAccounts,
  toStoredOrgAccount,
  type StoredOrgAccount,
} from '../auth/orgAccounts';
import type { TokenResponse } from '../api/types';
import type { AppRuntime } from '../runtime';
import { createApiClient, type ApiClient } from '../api/client';
import { createEndpoints, type Endpoints } from '../api/endpoints';
import { createTheme, type AppTheme } from '../theme';
import type { ColorScheme } from '@xa-todo/design-tokens';

interface AppContextValue {
  theme: AppTheme;
  scheme: ColorScheme;
  runtime: AppRuntime | null;
  session: StoredSession | null;
  /** 已认领的组织账号（「登录记录」，spec §4.2.5） */
  orgAccounts: StoredOrgAccount[];
  /** 组织 tab 当前展示哪一个组织；null 表示还没进入任何组织视图 */
  activeOrgIdentityId: number | null;
  setActiveOrgIdentityId: (identityId: number | null) => void;
  /** 从检索结果跳进组织视图时要定位的日期；消费后由组织页清空 */
  orgFocusDateKey: string | null;
  setOrgFocusDateKey: (dateKey: string | null) => void;
  /** 从服务端刷新「我的组织账号」列表（保留本地令牌） */
  refreshOrgAccounts: () => Promise<StoredOrgAccount[]>;
  /** 认领组织账号：登录成功即绑定成功，并把令牌存进登录记录 */
  claimOrgAccount: (org: string, memberKey: string) => Promise<StoredOrgAccount>;
  /** 解绑：删本地登录记录 + 服务端解绑 */
  unlinkOrgAccount: (identityId: number) => Promise<void>;
  /** 某个组织账号的接口客户端（自动刷新它的令牌）；账号不在本地时返回 null */
  orgApi: (identityId: number) => Endpoints | null;
  toggleScheme: () => void;
  setRuntime: (runtime: AppRuntime | null) => void;
  setSession: (session: StoredSession | null) => void;
  applyTokenResponse: (response: TokenResponse) => Promise<StoredSession>;
  signOut: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  systemScheme,
  children,
}: {
  systemScheme: ColorScheme;
  children: ReactNode;
}) {
  const [override, setOverride] = useState<ColorScheme | null>(null);
  const [runtime, setRuntime] = useState<AppRuntime | null>(null);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [orgAccounts, setOrgAccounts] = useState<StoredOrgAccount[]>([]);
  const [activeOrgIdentityId, setActiveOrgIdentityId] = useState<number | null>(null);
  const [orgFocusDateKey, setOrgFocusDateKey] = useState<string | null>(null);
  // 每个组织账号一个客户端：令牌各自独立，互不影响（不同组织的视图必须隔离）
  const orgClients = useRef(new Map<number, { client: ApiClient; api: Endpoints }>());

  const scheme = override ?? systemScheme;
  const theme = useMemo(() => createTheme(scheme), [scheme]);
  const toggleScheme = useCallback(() => {
    setOverride((current) => ((current ?? systemScheme) === 'light' ? 'dark' : 'light'));
  }, [systemScheme]);

  const persist = useCallback(async (next: StoredOrgAccount[]) => {
    setOrgAccounts(next);
    await saveOrgAccounts(next);
  }, []);

  /** 某个组织账号的客户端：令牌按需刷新，刷完写回登录记录。 */
  const clientFor = useCallback(
    (account: StoredOrgAccount): Endpoints => {
      if (!runtime) {
        throw new Error('运行时尚未初始化');
      }
      const cached = orgClients.current.get(account.identityId);
      if (cached) {
        return cached.api;
      }
      const client = createApiClient({
        baseUrl: runtime.baseUrl,
        session: createOrgTokenProvider({
          account,
          deviceId: runtime.deviceId,
          // 刷新走**裸客户端**：再带过期令牌会绕成递归
          bareClient: createApiClient({ baseUrl: runtime.baseUrl }),
          onRefreshed: (next) => {
            setOrgAccounts((current) => {
              const merged = current.map((item) =>
                item.identityId === next.identityId ? next : item,
              );
              void saveOrgAccounts(merged);
              return merged;
            });
          },
        }),
      });
      const api = createEndpoints(client);
      orgClients.current.set(account.identityId, { client, api });
      return api;
    },
    [runtime],
  );

  const refreshOrgAccounts = useCallback(async () => {
    if (!runtime) {
      return [];
    }
    // 服务端列表是权威（组织名/部门/角色可能变了），本地只提供令牌
    const remote = await runtime.api.orgAccounts();
    const local = await loadOrgAccounts();
    const tokensById = new Map(local.map((item) => [item.identityId, item]));
    const merged: StoredOrgAccount[] = remote.map((item) => {
      const tokens = tokensById.get(item.identityId);
      return {
        ...item,
        // 服务端不返回令牌（它不知道本地会话）；本地没有就留空，进入时会重新认领
        accessToken: tokens?.accessToken ?? '',
        refreshToken: tokens?.refreshToken ?? '',
        expiresAt: tokens?.expiresAt ?? 0,
      };
    });
    await persist(merged);
    return merged;
  }, [runtime, persist]);

  const claimOrgAccount = useCallback(
    async (org: string, memberKey: string) => {
      if (!runtime) {
        throw new Error('运行时尚未初始化');
      }
      const result = await runtime.api.claimOrgAccount(org, memberKey, runtime.deviceId);
      const stored = toStoredOrgAccount(result);
      const next = [...orgAccounts.filter((item) => item.identityId !== stored.identityId), stored];
      await persist(next);
      return stored;
    },
    [runtime, orgAccounts, persist],
  );

  const unlinkOrgAccount = useCallback(
    async (identityId: number) => {
      if (!runtime) {
        return;
      }
      await runtime.api.unlinkOrgAccount(identityId);
      orgClients.current.delete(identityId);
      await persist(orgAccounts.filter((item) => item.identityId !== identityId));
      if (activeOrgIdentityId === identityId) {
        setActiveOrgIdentityId(null);
      }
    },
    [runtime, orgAccounts, persist, activeOrgIdentityId],
  );

  const orgApi = useCallback(
    (identityId: number): Endpoints | null => {
      const account = orgAccounts.find((item) => item.identityId === identityId);
      if (!account || !account.refreshToken) {
        // 本地没有令牌（换机、或记录被清过）：交给上层重新认领一次
        return null;
      }
      return clientFor(account);
    },
    [orgAccounts, clientFor],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      theme,
      scheme,
      runtime,
      session,
      orgAccounts,
      activeOrgIdentityId,
      setActiveOrgIdentityId,
      orgFocusDateKey,
      setOrgFocusDateKey,
      refreshOrgAccounts,
      claimOrgAccount,
      unlinkOrgAccount,
      orgApi,
      toggleScheme,
      setRuntime,
      setSession,
      /**
       * 登录 / 选定身份 / 切换身份都必须走这里。
       *
       * 不能直接用 setSession：那只是 React 状态，不会写入安全存储，
       * 结果就是 App 一重启就要求重新登录——与「用户不感知重新登录」直接冲突。
       */
      applyTokenResponse: async (response: TokenResponse) => {
        if (!runtime) {
          throw new Error('运行时尚未初始化');
        }
        const stored = await runtime.session.setFromTokenResponse(response);
        setSession(stored);
        return stored;
      },
      signOut: async () => {
        await runtime?.session.clear();
        // 退出登录要连带清掉组织账号的登录记录：令牌还在本地就等于没退干净
        orgClients.current.clear();
        await persist([]);
        setActiveOrgIdentityId(null);
        setSession(null);
      },
    }),
    [theme, scheme, runtime, session, orgAccounts, activeOrgIdentityId, orgFocusDateKey,
     refreshOrgAccounts, claimOrgAccount, unlinkOrgAccount, orgApi, persist, toggleScheme],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function useAppContext(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error('useAppContext 必须在 AppProvider 内使用');
  }
  return value;
}

export function useAppTheme(): AppTheme {
  return useAppContext().theme;
}

export function useAppScheme(): ColorScheme {
  return useAppContext().scheme;
}

export function useAppSessionState() {
  const {
    session, setSession, toggleScheme, applyTokenResponse, signOut,
    orgAccounts, activeOrgIdentityId, setActiveOrgIdentityId, orgFocusDateKey, setOrgFocusDateKey,
    refreshOrgAccounts, claimOrgAccount, unlinkOrgAccount, orgApi,
  } = useAppContext();
  return {
    session, setSession, toggleScheme, applyTokenResponse, signOut,
    orgAccounts, activeOrgIdentityId, setActiveOrgIdentityId, orgFocusDateKey, setOrgFocusDateKey,
    refreshOrgAccounts, claimOrgAccount, unlinkOrgAccount, orgApi,
  };
}

/** 已登录后才可使用；未就绪时抛错以便尽早暴露装配问题。 */
export function useRuntime(): AppRuntime {
  const { runtime } = useAppContext();
  if (!runtime) {
    throw new Error('运行时尚未初始化');
  }
  return runtime;
}

export function useRuntimeState() {
  const { runtime, setRuntime } = useAppContext();
  return { runtime, setRuntime };
}
