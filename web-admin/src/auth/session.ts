const TOKEN_KEY = 'xa-todo.admin.token';

/**
 * 会话存储。后台令牌作用域为 ADMIN，与 C 端身份令牌互不通用（spec §3.4）。
 */
export interface AdminSession {
  accessToken: string;
  expiresAt: number;
  username: string;
  role: string;
}

/**
 * 存储读写在真实浏览器里都可能抛异常（Safari 隐私模式、存储被策略禁用），
 * 因此访问与调用都要兜住——降级为「本次会话不持久化」，而不是让页面崩溃。
 */
function readRaw(): string | null {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(value: string | null): void {
  try {
    if (value === null) {
      globalThis.localStorage?.removeItem(TOKEN_KEY);
    } else {
      globalThis.localStorage?.setItem(TOKEN_KEY, value);
    }
  } catch {
    // 存储不可用时静默降级
  }
}

export function saveSession(session: AdminSession): void {
  writeRaw(JSON.stringify(session));
}

export function loadSession(): AdminSession | null {
  const raw = readRaw();
  if (!raw) {
    return null;
  }
  try {
    const session = JSON.parse(raw) as AdminSession;
    if (!session.accessToken || session.expiresAt <= Date.now()) {
      clearSession();
      return null;
    }
    return session;
  } catch {
    clearSession();
    return null;
  }
}

export function clearSession(): void {
  writeRaw(null);
}

export function currentToken(): string | null {
  return loadSession()?.accessToken ?? null;
}
