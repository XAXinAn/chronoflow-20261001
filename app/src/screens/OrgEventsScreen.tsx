import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { OrgCurrent, OrgEvent } from '../api/types';
import type { Endpoints } from '../api/endpoints';
import { ApiError } from '../api/client';
import { MonthCalendar } from '../components/MonthCalendar';
import { Card, EmptyState, Screen } from '../components/ui';
import { WheelDatePicker } from '../components/WheelDatePicker';
import { useAppTheme } from '../context/AppContext';
import { dayHeading, formatTimeRange, localDateKey, locationLabel } from '../domain/agenda';
import { APP_TIMEZONE, buildMonthGrid, dateKeyToIso } from '../domain/calendar';
import { canDispatch } from '../domain/orgDispatch';
import type { RecognizedEventDraft } from '../domain/vision';
import { recognizePhoto, resolveDraftPlaces } from '../vision/recognizer';

function todayKey(): string {
  return localDateKey(new Date().toISOString(), APP_TIMEZONE);
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 组织日程：骨架与「日历」页完全一致——月视图 + 当日日程（spec §7.6 黑白极简）。
 *
 * 差异只在内容语义：组织日程对成员只读，卡片上多一个「我的回执」状态与回执按钮；
 * 悬浮按钮也与日历页同一套，但**新建入口按权限出现**——只有能下发的人（组织管理员、
 * 部门管理员）才看得到「新建组织日程」，普通成员依旧只读（spec §4.2.3）。
 */
export function OrgEventsScreen({
  api,
  orgName,
  onOpenAccounts,
  onCreateOrgEvent,
  onOpenRecognized,
  onEditOrgEvent,
  focusDateKey,
  onFocusApplied,
}: {
  /** 当前组织的接口客户端（组织 tab 里的每个组织各有一套令牌，spec §4.2.3） */
  api: Endpoints;
  orgName: string;
  onOpenAccounts: () => void;
  /** 新建并下发组织日程（spec §4.2.2）：整页表单里选下发对象 */
  onCreateOrgEvent: (dateKey: string) => void;
  /** 拍照识别出的草稿：进识别确认页，在那里选下发对象后批量下发（spec §4.1.9） */
  onOpenRecognized: (payload: {
    drafts: RecognizedEventDraft[];
    photoUri: string;
    sourceLabel: string;
    deviceFallbackReason: string | null;
    origin: 'ORG';
  }) => void;
  /** 发起人编辑自己下发的日程（`canEdit` 由服务端判定，spec §4.2.2） */
  onEditOrgEvent: (event: OrgEvent) => void;
  /** 从检索结果跳进来时要定位的日期（消费一次后由上层清空） */
  focusDateKey?: string | null;
  onFocusApplied?: () => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();

  const today = useMemo(todayKey, []);
  const [todayYear, todayMonth] = useMemo(() => {
    const [year, month] = today.split('-').map(Number) as [number, number];
    return [year, month];
  }, [today]);

  const [{ year, month }, setView] = useState({ year: todayYear, month: todayMonth });
  const [selectedDateKey, setSelectedDateKey] = useState(today);
  const [items, setItems] = useState<OrgEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [org, setOrg] = useState<OrgCurrent | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpDraft, setJumpDraft] = useState(selectedDateKey);
  const [photoBusy, setPhotoBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 与日历页一致：按整个月网格范围查询，相邻月份的补位格子也能显示圆点
      const grid = buildMonthGrid(year, month);
      setItems(await api.orgEvents(dateKeyToIso(grid.startDateKey), dateKeyToIso(grid.endDateKey, true)));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [api, year, month]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const current = await api.orgCurrent();
        if (active) {
          setOrg(current);
        }
      } catch {
        // 组织上下文拿不到时不显示新建入口即可，日历本身照常展示
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  // 从下发页返回、或切回本 tab 时重新拉取，否则刚下发的日程不会出现
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // 从检索结果跳进来：把视图与选中日期挪到那一条上，然后清掉这个一次性请求
  useEffect(() => {
    if (!focusDateKey) {
      return;
    }
    const [focusYear, focusMonth] = focusDateKey.split('-').map(Number) as [number, number];
    setView({ year: focusYear, month: focusMonth });
    setSelectedDateKey(focusDateKey);
    onFocusApplied?.();
  }, [focusDateKey, onFocusApplied]);

  const eventDates = useMemo(
    () => new Set(items.map((item) => localDateKey(item.startAt, APP_TIMEZONE))),
    [items],
  );

  const dayEvents = useMemo(
    () =>
      items
        .filter((item) => localDateKey(item.startAt, APP_TIMEZONE) === selectedDateKey)
        .sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [items, selectedDateKey],
  );

  const changeMonth = (nextYear: number, nextMonth: number) => {
    setView({ year: nextYear, month: nextMonth });
    const inThisMonth = today.startsWith(`${nextYear}-${pad(nextMonth)}`);
    setSelectedDateKey(inThisMonth ? today : `${nextYear}-${pad(nextMonth)}-01`);
  };

  const jumpToDate = (dateKey: string) => {
    const [focusYear, focusMonth] = dateKey.split('-').map(Number) as [number, number];
    setView({ year: focusYear, month: focusMonth });
    setSelectedDateKey(dateKey);
    setJumpOpen(false);
  };

  const dispatcher = org ? canDispatch(org) : false;

  /**
   * 拍照 → 上传 → 识别（spec §4.1.9）。
   *
   * 组织日程没有图片附件字段，照片只用于识别；识别出来的条目在确认页里选好
   * **下发对象**再批量下发。识别不可用时如实说明，并给「手动新建组织日程」的兜底——
   * 与日历页同一条链路、同一种诚实（模型未接入时后端返回 90002）。
   */
  const shootPhoto = () => {
    setError(null);
    Alert.alert('识别日程', '选择图片来源', [
      { text: '拍照', onPress: () => void pickPhoto('camera') },
      { text: '从相册选择', onPress: () => void pickPhoto('library') },
      { text: '取消', style: 'cancel' },
    ]);
  };

  const pickPhoto = async (from: 'camera' | 'library') => {
    if (from === 'camera') {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError('需要相机权限才能拍照');
        return;
      }
    }
    const picked = from === 'camera'
      ? await ImagePicker.launchCameraAsync({ quality: 0.8 })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.8 });
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }
    setPhotoBusy(true);
    try {
      const result = await recognizePhoto({ uri: picked.assets[0].uri, api });
      const drafts = await resolveDraftPlaces(result.items, api);
      onOpenRecognized({
        drafts,
        photoUri: result.imageUrl ?? picked.assets[0].uri,
        sourceLabel:
          result.source === 'device'
            ? `本机识别（${result.provider}）`
            : `服务器识别（${result.provider}）`,
        deviceFallbackReason: result.deviceFallbackReason,
        origin: 'ORG',
      });
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : '识别失败';
      Alert.alert('识别不可用', `${message}\n\n可以先用「＋」手动新建组织日程。`, [
        { text: '手动新建', onPress: () => onCreateOrgEvent(selectedDateKey) },
        { text: '知道了', style: 'cancel' },
      ]);
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.md,
          paddingTop: insets.top + theme.spacing.sm,
          paddingBottom: theme.spacing.xxl,
        }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
      >
        {/* 组织 tab 顶部固定显示当前组织：所有请求都带这个组织的令牌，切组织就整套换掉，避免串数据 */}
        <View style={styles.orgHeader}>
          <Text style={{ color: theme.color.textSecondary, fontSize: 13 }}>当前组织</Text>
          <Text style={{ color: theme.color.textPrimary, fontSize: 15, fontWeight: '600' }}>
            {orgName}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="账户管理" onPress={onOpenAccounts} hitSlop={10}>
            <Text style={{ color: theme.color.accent, fontSize: 14 }}>账户管理</Text>
          </Pressable>
        </View>

          <MonthCalendar
          year={year}
          month={month}
          selectedDateKey={selectedDateKey}
          todayKey={today}
          eventDates={eventDates}
          onSelectDate={setSelectedDateKey}
          onChangeMonth={changeMonth}
          // 组织日历同样提供「今天」：骨架与日历页同构，交互也不该两套
          onToday={() => {
            const [todayYear, todayMonth] = today.split('-').map(Number) as [number, number];
            setView({ year: todayYear, month: todayMonth });
            setSelectedDateKey(today);
          }}
        />

        <View style={[styles.divider, { backgroundColor: theme.color.border }]} />

        <Text style={[styles.dayHeading, { color: theme.color.textPrimary }]}>
          {dayHeading(selectedDateKey, today)}
        </Text>

        {error ? <Text style={{ color: theme.color.danger, marginBottom: 8 }}>{error}</Text> : null}

        {!loading && dayEvents.length === 0 ? (
          <EmptyState title="这天没有组织日程" hint="下拉可刷新" />
        ) : null}

        {dayEvents.map((item) => (
          <View key={`${item.eventId}-${item.startAt}`} style={{ marginBottom: theme.spacing.sm }}>
            <Card>
              <View style={styles.eventRow}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>
                    {item.title}
                  </Text>
                  <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginTop: 2 }}>
                    {formatTimeRange(item.startAt, item.endAt, item.allDay, item.timezone || APP_TIMEZONE)}
                    {locationLabel(item.location, item.locationDetail)
                      ? ` · ${locationLabel(item.location, item.locationDetail)}`
                      : ''}
                  </Text>
                </View>
                <View style={styles.pills}>
                  {/* 首版不收集回执（spec §4.2.2）：卡片与日历页长得一样，
                      唯一的差别是发起人自己那条多一个「编辑」 */}
                  {item.canEdit ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`编辑-${item.title}`}
                      onPress={() => onEditOrgEvent(item)}
                      hitSlop={8}
                    >
                      <Text style={{ color: theme.color.accent, fontSize: 13 }}>编辑</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>

            </Card>
          </View>
        ))}
      </ScrollView>

      {/* 跳到指定日期：与日历页同一个滚轮选择层（spec §4.2.3 悬浮按钮同一套） */}
      {jumpOpen ? (
        <View
          style={[
            styles.jumpLayer,
            {
              backgroundColor: theme.color.surfaceRaised,
              borderColor: theme.color.border,
              borderRadius: theme.radius.card,
              shadowColor: theme.color.textPrimary,
            },
          ]}
          accessibilityViewIsModal
        >
          <Text style={[styles.jumpTitle, { color: theme.color.textSecondary }]}>跳到指定日期</Text>
          <WheelDatePicker value={jumpDraft} onChange={setJumpDraft} />
          <View style={styles.jumpActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="回到今天"
              onPress={() => jumpToDate(today)}
            >
              <Text style={{ color: theme.color.accent, fontSize: 15, fontWeight: '600' }}>回到今天</Text>
            </Pressable>
            <View style={styles.jumpConfirm}>
              <Pressable accessibilityRole="button" accessibilityLabel="取消" onPress={() => setJumpOpen(false)}>
                <Text style={{ color: theme.color.textSecondary, fontSize: 15 }}>取消</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="确定" onPress={() => jumpToDate(jumpDraft)}>
                <Text style={{ color: theme.color.accent, fontSize: 15 }}>确定</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {/* 只有能下发的人才会看到这两个按钮（spec §4.2.3）：显示了再报 403 是拿用户当测试员 */}
      {dispatcher ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="拍照"
            onPress={() => shootPhoto()}
            style={({ pressed }) => [
              styles.cameraFab,
              {
                backgroundColor: theme.color.surfaceRaised,
                borderColor: theme.color.border,
                opacity: pressed ? 0.85 : 1,
              },
            ]}
          >
            {photoBusy ? (
              <ActivityIndicator color={theme.color.textPrimary} />
            ) : (
              <Ionicons name="camera-outline" size={24} color={theme.color.textPrimary} />
            )}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="跳到指定日期"
            onPress={() =>
              setJumpOpen((current) => {
                if (!current) {
                  setJumpDraft(selectedDateKey);
                }
                return !current;
              })
            }
            style={({ pressed }) => [
              styles.jumpFab,
              {
                backgroundColor: theme.color.surfaceRaised,
                borderColor: theme.color.border,
                opacity: pressed ? 0.85 : 1,
              },
            ]}
          >
            <Ionicons name="calendar-outline" size={24} color={theme.color.textPrimary} />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="新建组织日程"
            onPress={() => onCreateOrgEvent(selectedDateKey)}
            style={({ pressed }) => [
              styles.fab,
              {
                backgroundColor: theme.color.accent,
                opacity: pressed ? 0.85 : 1,
                transform: [{ scale: pressed ? 0.96 : 1 }],
              },
            ]}
          >
            <Text style={[styles.fabPlus, { color: theme.color.accentContrast }]}>＋</Text>
          </Pressable>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  orgHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 10,
  },
  divider: { height: 1, marginVertical: 14 },
  dayHeading: { fontSize: 15, fontWeight: '600', marginBottom: 10 },
  eventRow: { flexDirection: 'row', alignItems: 'center' },
  pills: { flexDirection: 'row', gap: 6 },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1 },
  // 悬浮按钮的尺寸与位置与日历页逐字一致（同一套按钮排布，spec §4.2.3）
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabPlus: { fontSize: 28, lineHeight: 32 },
  jumpFab: {
    position: 'absolute',
    right: 20,
    // 位于新建按钮上方，留出 12px 间隔
    bottom: 24 + 56 + 12,
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraFab: {
    position: 'absolute',
    right: 20,
    // 再往上排一个：与「跳到指定日期」同样间隔 12px（与日历页逐字一致）
    bottom: 24 + (56 + 12) * 2,
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  jumpLayer: {
    position: 'absolute',
    top: 96,
    left: 16,
    right: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    elevation: 8,
  },
  jumpTitle: { fontSize: 13, fontWeight: '600', marginBottom: 8, paddingHorizontal: 4 },
  jumpActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginTop: 8,
  },
  jumpConfirm: { flexDirection: 'row', alignItems: 'center', gap: 20 },
});
