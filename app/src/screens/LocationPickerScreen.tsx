import { useCallback, useEffect, useRef, useState } from 'react';
import { userFacingError } from '../domain/errors';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';

import type { GeoPlace, GeoStatus } from '../api/types';
import { Card, PrimaryButton, Screen } from '../components/ui';
import { FormInput } from '../components/form';
import { askPermission } from '../components/permission';
import {
  MapPicker,
  type MapFocus,
  type MapLocate,
  type MapPhase,
  type MapPickerHandle,
} from '../components/MapPicker';
import { useAppTheme, useRuntime } from '../context/AppContext';

/** 图钉位置的来源：搜索选中 vs 手动拖动。两者的「确认」语义不同，必须区分。 */
type CenterSource = 'search' | 'drag' | null;

const RESOLVE_DEBOUNCE_MS = 700;
/** 实时定位最多等这么久；超时就退到缓存位置，宁可位置略旧也不要一直转圈 */
const LOCATE_TIMEOUT_MS = 8000;

/**
 * 本次会话是否已经为「进页面自动定位」解释并申请过定位权限。
 *
 * <p>**必须问一次**：不问的话第一眼看到的是兜底坐标（`39.9087/116.3975` = 天安门），
 * 而不是「我的位置」——用户会以为定位坏了。
 * **只问一次**：每次进页面都弹说明属于审核规范 §四点名的「频繁弹窗」，
 * 用户拒绝之后就别再打扰，右下角的定位按钮仍然可以随时手动再来一次。
 */
let autoLocateAskedThisSession = false;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('定位超时')), ms)),
  ]);
}

/**
 * 地点选择页（spec §5.9）。
 *
 * 搜索与地图选点是**同一件事的两半**：搜到之后要看一眼地图确认位置对不对，
 * 位置不对就拖一下微调。所以不做两个 tab，而是把两者叠在一起——
 * 搜索框常驻顶部，地图常驻下方，结果列表浮在中间；点结果地图飞过去，拖地图图钉跟着走。
 *
 * 地图能力受凭证约束：服务端没配 Web端(JS API) Key 时只保留搜索，而不是给一个点了就白屏的入口。
 */
export function LocationPickerScreen({
  initialLatitude,
  initialLongitude,
  onCancel,
  onPick,
}: {
  initialLatitude: number | null;
  initialLongitude: number | null;
  onCancel: () => void;
  onPick: (place: GeoPlace | null) => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();

  const mapRef = useRef<MapPickerHandle>(null);
  const [status, setStatus] = useState<GeoStatus | null>(null);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<GeoPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mapPhase, setMapPhase] = useState<MapPhase>('loading');
  /**
   * 兜底中心点：**只在定位失败时**才用。
   *
   * 不能一进页面就先把默认位置显示出来——用户还没看到自己的位置就先闪一个无关城市，
   * 会让人以为定位错了。所以 focus 初值为 null，地图要等定位结果才建。
   */
  const fallback = {
    latitude: initialLatitude ?? 39.9087,
    longitude: initialLongitude ?? 116.3975,
  };
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [locate, setLocate] = useState<MapLocate | null>(null);
  const [locating, setLocating] = useState(false);
  const [center, setCenter] = useState<{ latitude: number; longitude: number } | null>(null);
  const [centerSource, setCenterSource] = useState<CenterSource>(null);
  const [resolved, setResolved] = useState<GeoPlace | null>(null);
  const [resolving, setResolving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setStatus(await api.geoConfig());
      } catch {
        // 拿不到状态不影响搜索本身，静默即可
      }
    })();
  }, [api]);

  useEffect(() => () => {
    if (resolveTimer.current) {
      clearTimeout(resolveTimer.current);
    }
  }, []);

  const mapAvailable = Boolean(status?.jsApiKey);

  /** 坐标 → 地点名。地图动作是连续的，反查要防抖，否则拖一次会打出一串请求。 */
  const resolveCenter = useCallback(
    async (latitude: number, longitude: number) => {
      setResolving(true);
      try {
        setResolved(await api.geoRegeo(latitude, longitude));
      } catch {
        // 反查失败不阻塞选点：坐标本身仍然可用，确认时再试一次
        setResolved(null);
      } finally {
        setResolving(false);
      }
    },
    [api],
  );

  const handleCenterChanged = (latitude: number, longitude: number) => {
    setCenter({ latitude, longitude });
    setCenterSource('drag');
    setResolved(null);
    if (resolveTimer.current) {
      clearTimeout(resolveTimer.current);
    }
    resolveTimer.current = setTimeout(() => void resolveCenter(latitude, longitude), RESOLVE_DEBOUNCE_MS);
  };

  const handlePhaseChange = (next: MapPhase, message?: string) => {
    setMapPhase(next);
    if (next === 'error' && message) {
      setError(message);
    }
    if (next === 'mapped') {
      // 地图就绪后立刻取一次中心点，让底部地址栏有内容，而不是空白
      mapRef.current?.getCenter();
    }
  };

  const handleCenterRequested = (latitude: number, longitude: number) => {
    setCenter({ latitude, longitude });
    if (!resolved) {
      void resolveCenter(latitude, longitude);
    }
  };

  const search = async () => {
    const trimmed = keyword.trim();
    if (!trimmed) {
      setError('请先输入地点关键字');
      return;
    }
    setSearching(true);
    setError(null);
    try {
      setResults(await api.geoPlaces(trimmed));
    } catch (cause) {
      setError(userFacingError(cause, '搜索失败'));
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  /** 点搜索结果：地图飞过去，图钉落在这个点上，并记住这是「显式选中」。 */
  const chooseResult = (place: GeoPlace) => {
    setFocus((current) => ({
      version: (current?.version ?? 0) + 1,
      latitude: place.latitude,
      longitude: place.longitude,
    }));
    setCenter({ latitude: place.latitude, longitude: place.longitude });
    setCenterSource('search');
    setResolved(place);
    setResults([]);
    if (resolveTimer.current) {
      clearTimeout(resolveTimer.current);
    }
  };

  const confirm = async () => {
    // 显式选中的 POI 直接用它：用户点的就是这个地方，不该被反查结果改名
    if (centerSource === 'search' && resolved) {
      onPick(resolved);
      return;
    }
    if (!center) {
      mapRef.current?.getCenter();
      setError('正在读取当前位置，请稍后再试');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      onPick(await api.geoRegeo(center.latitude, center.longitude));
    } catch (cause) {
      setError(userFacingError(cause, '该位置解析失败，换个点再试'));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * 定位到当前位置。
   *
   * 这里只负责拿到 GPS 坐标（WGS-84），**转换交给地图 SDK**——
   * 高德展示层是 GCJ-02，直接把 GPS 坐标丢上去会偏几百米。
   *
   * @param auto 进页面时的自动定位。自动定位失败只给一句温和提示，
   *             不该像手动点击那样弹一条红色错误把用户吓一跳。
   */
  const locateMe = useCallback(async (auto = false): Promise<boolean> => {
    setLocating(true);
    setError(null);
    try {
      /**
       * 先说明用途再申请系统权限，**进页面这次也要问**（见 `autoLocateAskedThisSession`）。
       *
       * <p>以前的写法是自动定位一律 `quiet`（没授权就直接放弃），结果地图永远落在
       * 北京的兜底坐标上；现在首次进页面走完整流程，之后再进只是安静地复用已有授权。
       * **绝不允许**因为没给定位就退出页面——规范 §四把「拒绝权限后强制退出」列为违规。
       */
      const quiet = auto && autoLocateAskedThisSession;
      autoLocateAskedThisSession = true;
      if (!(await askPermission('location', { quiet }))) {
        setError(
          auto
            ? '未授权定位，已打开默认位置；可点右下角图标重试，或直接搜索地点'
            : '未授予定位权限，无法定位到当前位置；可搜索地点或手工输入地址',
        );
        return false;
      }
      // 先争一次实时定位（用 GPS，模拟器与真机都能拿到 fix），
      // 超时或失败就退到系统缓存的上次位置，避免原地转圈。
      let position: Location.LocationObject | null = null;
      try {
        position = await withTimeout(
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
          LOCATE_TIMEOUT_MS,
        );
      } catch {
        position = await Location.getLastKnownPositionAsync();
      }
      if (!position) {
        throw new Error('定位超时');
      }
      setLocate((current) => ({
        version: (current?.version ?? 0) + 1,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      }));
      return true;
    } catch (cause) {
      if (auto) {
        setError('暂时取不到当前位置，已打开默认位置；可点右下角图标重试');
      } else {
        // 原生定位报错（权限被系统收回、GPS 没信号…）的原文对用户没有意义，
        // 直接告诉他可以怎么做：重试或换搜索
        setError('定位失败，请稍后重试，也可以直接搜索地点');
      }
      return false;
    } finally {
      setLocating(false);
    }
  }, []);

  /**
   * 进页面就落到「我的位置」。
   *
   * 等地图 ready 再触发，否则命令会早于地图对象创建而被丢掉。
   * 只自动跑一次：用户之后手动拖动地图不应该被自动定位拽回去。
   */
  const autoLocated = useRef(false);
  useEffect(() => {
    // 等 SDK 就绪即可定位——此时地图还没建，正好让第一个位置决定地图落在哪
    if (mapPhase !== 'sdk' || autoLocated.current || !mapAvailable) {
      return;
    }
    autoLocated.current = true;
    void (async () => {
      const ok = await locateMe(true);
      if (!ok) {
        // 定位失败才退到兜底位置，保证地图至少能出来
        setFocus((current) => ({
          version: (current?.version ?? 0) + 1,
          latitude: fallback.latitude,
          longitude: fallback.longitude,
        }));
      }
    })();
  }, [mapPhase, mapAvailable, locateMe, fallback.latitude, fallback.longitude]);

  const footerText = (() => {
    if (mapPhase === 'error') {
      return null;
    }
    if (mapPhase !== 'mapped') {
      return '正在定位…';
    }
    if (centerSource === 'search' && resolved) {
      return resolved.name;
    }
    if (resolving) {
      return '正在识别位置…';
    }
    if (resolved) {
      return resolved.address ?? resolved.name;
    }
    return '拖动地图，把图钉对准目标位置';
  })();

  return (
    <Screen>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + theme.spacing.sm,
            backgroundColor: theme.color.surfaceRaised,
            borderBottomColor: theme.color.border,
          },
        ]}
      >
        <Pressable accessibilityRole="button" accessibilityLabel="取消" onPress={onCancel} hitSlop={10}>
          <Text style={{ color: theme.color.textSecondary, fontSize: 16 }}>取消</Text>
        </Pressable>
        <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>选择地点</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="不设地点" onPress={() => onPick(null)} hitSlop={10}>
          <Text style={{ color: theme.color.textSecondary, fontSize: 16 }}>不设</Text>
        </Pressable>
      </View>

      <View style={{ flex: 1, paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm }}>
        <View style={styles.searchRow}>
          <View style={{ flex: 1 }}>
            <Card>
              <FormInput
                value={keyword}
                onChangeText={setKeyword}
                placeholder="搜索地点，如：北京南站"
                accessibilityLabel="搜索地点"
              />
            </Card>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="搜索"
            onPress={() => void search()}
            disabled={searching}
            style={[
              styles.searchButton,
              { backgroundColor: theme.color.accent, borderRadius: theme.radius.button },
            ]}
          >
            <Text style={{ color: theme.color.accentContrast, fontWeight: '600', fontSize: 15 }}>
              {searching ? '…' : '搜索'}
            </Text>
          </Pressable>
        </View>

        {mapAvailable ? (
          <View style={{ flex: 1, marginTop: theme.spacing.sm }}>
            <MapPicker
              ref={mapRef}
              focus={focus}
              locate={locate}
              onCenterChanged={handleCenterChanged}
              onCenterRequested={handleCenterRequested}
              onPhaseChange={handlePhaseChange}
            />

            {/* 定位按钮浮在地图右下角，和主流地图 App 的位置一致 */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="定位到当前位置"
              onPress={() => void locateMe()}
              disabled={locating || mapPhase !== 'mapped'}
              style={({ pressed }) => [
                styles.locateButton,
                {
                  backgroundColor: theme.color.surfaceRaised,
                  borderColor: theme.color.border,
                  opacity: pressed ? 0.7 : locating || mapPhase !== 'mapped' ? 0.5 : 1,
                },
              ]}
            >
              <Ionicons
                name={locating ? 'hourglass-outline' : 'locate-outline'}
                size={20}
                color={theme.color.textPrimary}
              />
            </Pressable>
          </View>
        ) : (
          <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: theme.spacing.sm }}>
            未配置 Web端(JS API) Key，暂不可用地图选点
          </Text>
        )}

        {/* 结果列表浮在地图上方，避免挤掉地图本身 */}
        {results.length > 0 ? (
          <View style={[styles.results, { backgroundColor: theme.color.surfaceRaised, borderColor: theme.color.border }]}>
            <ScrollView keyboardShouldPersistTaps="handled">
              {results.map((place) => (
                <Pressable
                  key={`${place.poiId ?? place.name}-${place.latitude}`}
                  accessibilityRole="button"
                  accessibilityLabel={`地点-${place.name}`}
                  onPress={() => chooseResult(place)}
                  style={[styles.resultRow, { borderBottomColor: theme.color.border }]}
                >
                  <Text style={{ color: theme.color.textPrimary, fontSize: 15, fontWeight: '600' }}>
                    {place.name}
                  </Text>
                  {place.address ? (
                    <Text style={{ color: theme.color.textSecondary, fontSize: 12, marginTop: 2 }}>
                      {place.address}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {status?.degraded ? (
          <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 6 }}>
            {status.degradedReason ?? '当前使用内置地点集'}
          </Text>
        ) : null}

        {footerText ? (
          <Text
            numberOfLines={2}
            style={{ color: theme.color.textSecondary, fontSize: 13, marginTop: 6, textAlign: 'center' }}
          >
            {footerText}
          </Text>
        ) : null}

        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 12, marginTop: 4 }}>{error}</Text>
        ) : null}

        <View style={{ marginTop: theme.spacing.sm, marginBottom: theme.spacing.md }}>
          <PrimaryButton
            title={submitting ? '处理中…' : '确认此位置'}
            onPress={() => void confirm()}
            loading={submitting}
            // 地图还没落到「我的位置」之前不允许确认，避免确认到一个用户没看到过的点
            disabled={mapPhase !== 'mapped'}
          />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchButton: { paddingHorizontal: 18, paddingVertical: 14 },
  results: {
    position: 'absolute',
    left: 20,
    right: 20,
    top: 84,
    maxHeight: 240,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: 'hidden',
    zIndex: 10,
  },
  resultRow: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  locateButton: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
