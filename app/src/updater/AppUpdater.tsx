import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { getContentUriAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { userFacingError } from '../domain/errors';
import { Card } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import {
  decideUpdate,
  forceReasonText,
  formatBytes,
  resolveApkUrl,
  updateChangelog,
  updateTitle,
  type UpdateDecision,
} from '../domain/appUpdate';

/**
 * 应用内更新（spec §4.1.11）。
 *
 * <p>链路：启动（以及「我的 → 检查更新」）→ `GET /system/app-release` 比对版本号 →
 * 弹更新说明 → 下载 APK → 调**系统安装器**安装。**不静默安装**：装不装最终由用户在
 * 系统界面点确认，这是 Android 的规矩，也是我们该守的边界。
 *
 * <p>几条刻意的取舍：
 * - **只在 Android 生效**：iOS 不允许 App 自己下载安装包，走商店升级；
 * - **读不到本地版本号就不检查**（Expo Go / Web）：那种环境本来也装不了 APK，
 *   弹出来只会让人困惑（`decideUpdate` 里有对应分支）；
 * - **这个 Provider 挂在「同意隐私政策之后」**：同意前不发任何请求（合规要求）；
 * - 下载用 `expo-file-system` 的新 API（`File.createDownloadTask` 能拿到进度），
 *   只有「取 content:// 给系统安装器」这一步用 legacy 的 `getContentUriAsync`——
 *   新 API 没有对应能力，而 Android 7+ 必须用 content://（file:// 会抛 FileUriExposedException）。
 */

/** 本机安装包的 `versionCode`；读不到返回 0（Expo Go / Web / 未知平台）。 */
export function readLocalVersionCode(): number {
  // 原生构建号最准（来自 build.gradle 的 versionCode）；Expo Go 下是 null
  const native = Number(Constants.nativeBuildVersion ?? '');
  if (Number.isFinite(native) && native > 0) {
    return Math.floor(native);
  }
  const fromConfig = Constants.expoConfig?.android?.versionCode;
  return typeof fromConfig === 'number' && fromConfig > 0 ? Math.floor(fromConfig) : 0;
}

/** 展示用版本名（「我的」页那一行）。 */
export function readLocalVersionName(): string {
  return Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? '未知';
}

type Pending = Extract<UpdateDecision, { kind: 'optional' } | { kind: 'force' }>;

interface AppUpdateApi {
  /** 检查更新；`manual` 时无论有没有更新都会给用户一个明确反馈 */
  check: (manual?: boolean) => Promise<void>;
  currentVersionName: string;
}

const AppUpdateContext = createContext<AppUpdateApi | null>(null);

export function useAppUpdate(): AppUpdateApi {
  const value = useContext(AppUpdateContext);
  if (!value) {
    throw new Error('useAppUpdate 必须在 AppUpdateProvider 内使用');
  }
  return value;
}

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const theme = useAppTheme();
  const { api, baseUrl } = useRuntime();
  const localVersionCode = useMemo(readLocalVersionCode, []);
  const currentVersionName = useMemo(readLocalVersionName, []);

  const [pending, setPending] = useState<Pending | null>(null);
  const [phase, setPhase] = useState<'idle' | 'downloading'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const checking = useRef(false);

  const check = useCallback(
    async (manual = false) => {
      if (checking.current) {
        return;
      }
      checking.current = true;
      try {
        const release = await api.appRelease();
        const decision = decideUpdate(localVersionCode, release);
        if (decision.kind === 'none') {
          if (manual) {
            Alert.alert('已是最新版本', `当前版本 ${currentVersionName}`);
          }
          return;
        }
        setError(null);
        setPhase('idle');
        setProgress(0);
        setPending(decision);
      } catch (cause) {
        // 启动时的静默检查失败不打扰用户（可能只是没网）；手动检查要如实说
        if (manual) {
          Alert.alert('检查更新失败', userFacingError(cause, '稍后再试'));
        }
      } finally {
        checking.current = false;
      }
    },
    [api, currentVersionName, localVersionCode],
  );

  // 启动检查一次。Provider 挂在「已同意隐私政策」之后，所以这里发请求是合规的
  useEffect(() => {
    void check(false);
  }, [check]);

  const startUpdate = useCallback(async () => {
    if (!pending) {
      return;
    }
    const url = resolveApkUrl(pending.release.apkUrl, baseUrl);
    if (!url || Platform.OS !== 'android') {
      setError('当前环境不支持应用内更新，请到应用商店或官网下载新版。');
      return;
    }
    setPhase('downloading');
    setProgress(0);
    setError(null);
    try {
      const target = new File(Paths.cache, `chronoflow-${pending.release.versionCode ?? 0}.apk`);
      if (target.exists) {
        // 上一次下了一半 / 下完没装：删掉重下，否则会报「目标已存在」
        target.delete();
      }
      const task = File.createDownloadTask(url, target, {
        onProgress: ({ bytesWritten, totalBytes }) => {
          // totalBytes 为 -1 表示服务端没给 Content-Length：这时不显示假的进度
          if (totalBytes > 0) {
            setProgress(bytesWritten / totalBytes);
          }
        },
      });
      const file = await task.downloadAsync();
      if (!file) {
        // 文档里的 null 只出现在「任务被暂停」时；我们没实现暂停，真出现就当失败
        throw new Error('安装包没有下载完成，请重试');
      }

      // 大小对账：配了 sizeBytes 就比一下，能挡住被截断 / 被网关替换的下载。
      // （sha256 也由服务端下发，留给人工/运维核对，App 侧不额外引一个哈希库。）
      const expected = pending.release.sizeBytes ?? 0;
      if (expected > 0 && typeof file.size === 'number' && Math.abs(file.size - expected) > 1024) {
        throw new Error(`安装包大小对不上（应为 ${expected} 字节，实际 ${file.size} 字节）`);
      }

      // Android 7+ 必须把这个文件包成 content:// 才能交给系统安装器
      const contentUri = await getContentUriAsync(file.uri);
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        type: 'application/vnd.android.package-archive',
        flags: 1, // FLAG_GRANT_READ_URI_PERMISSION：临时把读权限授给安装器
      });
      // 系统安装界面已经起来了：收起弹层，用户装完打开的就是新版本
      setPhase('idle');
      setPending(null);
    } catch (cause) {
      setPhase('idle');
      setError(userFacingError(cause, '下载失败，请稍后再试'));
    }
  }, [baseUrl, pending]);

  const value = useMemo<AppUpdateApi>(
    () => ({ check, currentVersionName }),
    [check, currentVersionName],
  );

  const downloading = phase === 'downloading';

  return (
    <AppUpdateContext.Provider value={value}>
      {children}

      {pending ? (
        <View style={styles.overlay}>
          <Card style={styles.card}>
            <Text style={[styles.title, { color: theme.color.textPrimary }]}>
              {updateTitle(pending.release)}
            </Text>
            <Text style={[styles.meta, { color: theme.color.textTertiary }]}>
              {[
                formatBytes(pending.release.sizeBytes),
                pending.kind === 'force' ? '必须更新' : '可稍后更新',
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>

            <ScrollView style={styles.body}>
              <Text style={{ color: theme.color.textPrimary, fontSize: 14, lineHeight: 21 }}>
                {updateChangelog(pending.release)}
              </Text>
              {pending.kind === 'force' ? (
                <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: 12 }}>
                  {forceReasonText(pending)}
                </Text>
              ) : null}
            </ScrollView>

            {downloading ? (
              <View style={{ marginTop: 12 }}>
                <Text style={[styles.meta, { color: theme.color.textSecondary }]}>
                  {progress > 0 ? `正在下载 ${Math.round(progress * 100)}%` : '正在下载…'}
                </Text>
                <View style={[styles.bar, { backgroundColor: theme.color.border }]}>
                  <View
                    style={[
                      styles.barFill,
                      { backgroundColor: theme.color.accent, width: `${Math.round(progress * 100)}%` },
                    ]}
                  />
                </View>
              </View>
            ) : null}

            {error ? (
              <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: 10 }}>{error}</Text>
            ) : null}

            <View style={styles.actions}>
              {/* 强制更新不给「稍后」；可选更新才让用户跳过 */}
              {pending.kind === 'optional' && !downloading ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="稍后再说"
                  hitSlop={8}
                  onPress={() => {
                    setPending(null);
                    setError(null);
                  }}
                >
                  <Text style={{ color: theme.color.textSecondary, fontSize: 15 }}>稍后</Text>
                </Pressable>
              ) : (
                <View />
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={downloading ? '正在下载' : '立即更新'}
                accessibilityState={{ busy: downloading, disabled: downloading }}
                hitSlop={8}
                onPress={downloading ? undefined : () => void startUpdate()}
              >
                <Text
                  style={{
                    color: downloading ? theme.color.textTertiary : theme.color.accent,
                    fontSize: 15,
                    fontWeight: '600',
                  }}
                >
                  {downloading ? '下载中…' : error ? '重试' : '立即更新'}
                </Text>
              </Pressable>
            </View>
          </Card>
        </View>
      ) : null}
    </AppUpdateContext.Provider>
  );
}

const styles = StyleSheet.create({
  /** 盖住整页：强制更新时用户不能绕过（Android 返回键也不会关掉它） */
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: 'rgba(0,0,0,0.35)',
    zIndex: 40,
  },
  card: { width: '100%', padding: 20 },
  title: { fontSize: 17, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 4 },
  body: { maxHeight: 220, marginTop: 12 },
  bar: { height: 4, borderRadius: 2, marginTop: 8, overflow: 'hidden' },
  barFill: { height: 4, borderRadius: 2 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 18,
  },
});
