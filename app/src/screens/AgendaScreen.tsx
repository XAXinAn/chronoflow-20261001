import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '../api/client';
import type { EventOccurrence, HolidayResponse, SearchResultItem } from '../api/types';
import { MonthCalendar } from '../components/MonthCalendar';
import { WheelDatePicker } from '../components/WheelDatePicker';
import { ListGroup, ListRow, ListSeparator, SectionHeader } from '../components/list';
import { Card, EmptyState, Pill, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { dayHeading, formatTimeRange, localDateKey } from '../domain/agenda';
import { APP_TIMEZONE, buildMonthGrid, dateKeyToIso } from '../domain/calendar';
import { holidayName, toHolidayMarks, yearsSpanned } from '../domain/holiday';
import { resultBadges, resultDateKey, resultSubtitle, resultTypeLabel } from '../domain/search';

/** 检索防抖：每敲一个字就发一次请求既费流量，也会让结果闪。 */
const SEARCH_DEBOUNCE_MS = 300;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function todayKey(): string {
  return localDateKey(new Date().toISOString(), APP_TIMEZONE);
}

/**
 * 首页：常驻搜索框 + 日历 + 当日日程（spec §4.1.7、§7.6 黑白极简）。
 *
 * 三件事在这一页里：
 * 1. **检索**（spec §4.1.7）：顶部常驻搜索框，走服务端**全量**检索，不受当前月份限制；
 * 2. **跳到指定日期**：新建按钮上方再放一个悬浮按钮，点开是复用月历的选择层；
 * 3. **节假日/调休**（spec §4.1.2 / §5.11）：日期格子上标「休 / 班」。
 */
export function AgendaScreen({
  onCreateEvent,
  onOpenEvent,
  onOpenTask,
  onOpenOrgEvent,
  onOpenAgent,
}: {
  onCreateEvent: (dateKey: string) => void;
  onOpenEvent: (eventId: number, dateKey: string, occurrenceDate: string | null) => void;
  onOpenTask: (taskId: number) => void;
  /** 组织日程结果：切到那个组织的视图并选中那天（只读，进不了个人编辑页） */
  onOpenOrgEvent: (identityId: number, dateKey: string) => void;
  /** 智能助手入口（spec §11 阶段三预留） */
  onOpenAgent: (payload?: { photoUrl?: string }) => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();
  const today = useMemo(todayKey, []);
  const [todayYear, todayMonth] = useMemo(() => {
    const [year, month] = today.split('-').map(Number) as [number, number];
    return [year, month];
  }, [today]);

  const [{ year, month }, setView] = useState({ year: todayYear, month: todayMonth });
  const [selectedDateKey, setSelectedDateKey] = useState(today);
  const [occurrences, setOccurrences] = useState<EventOccurrence[]>([]);
  const [holidays, setHolidays] = useState<HolidayResponse[]>([]);
  const [holidayError, setHolidayError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  /** 滚轮里的草稿日期：滚动过程不立刻跳，点「确定」才落到日历上 */
  const [jumpDraft, setJumpDraft] = useState(selectedDateKey);

  const searchActive = keyword.trim().length > 0;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const currentGrid = buildMonthGrid(year, month);
      // 节假日按年取：网格会带出上/下月补位，可能跨年，所以取网格覆盖到的每一年
      const years = yearsSpanned(currentGrid.startDateKey, currentGrid.endDateKey);
      const [occurrenceList, holidayLists] = await Promise.all([
        api.eventsInRange(
          dateKeyToIso(currentGrid.startDateKey),
          dateKeyToIso(currentGrid.endDateKey, true),
        ),
        // 节假日是附属信息：拿不到就只是不显示标记，但要让用户看见这一点，
        // 不能悄悄吞掉——否则「这天怎么没标休」会变成一个查不出的谜
        Promise.all(years.map((item) => api.holidays(item))).catch(() => {
          setHolidayError(true);
          return [] as HolidayResponse[];
        }),
      ]);
      setHolidayError(false);
      setOccurrences(occurrenceList);
      setHolidays(holidayLists);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [api, year, month]);

  // 从编辑页返回、或切回本 tab 时都要重新拉取，否则新建的日程不会出现
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    const trimmed = keyword.trim();
    if (!trimmed) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const items = await api.search(trimmed);
          if (!cancelled) {
            setResults(items);
            setSearchError(null);
          }
        } catch (cause) {
          if (!cancelled) {
            setResults([]);
            setSearchError(cause instanceof ApiError ? cause.message : '检索失败');
          }
        } finally {
          if (!cancelled) {
            setSearching(false);
          }
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, keyword]);

  const eventDates = useMemo(
    () => new Set(occurrences.map((item) => localDateKey(item.startAt, APP_TIMEZONE))),
    [occurrences],
  );
  const holidayMarks = useMemo(() => toHolidayMarks(holidays), [holidays]);

  const dayEvents = useMemo(
    () =>
      occurrences
        .filter((item) => localDateKey(item.startAt, APP_TIMEZONE) === selectedDateKey)
        .sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [occurrences, selectedDateKey],
  );

  const changeMonth = (nextYear: number, nextMonth: number) => {
    setView({ year: nextYear, month: nextMonth });
    // 新月份若包含今天则选今天，否则选 1 号
    const inThisMonth = today.startsWith(`${nextYear}-${pad(nextMonth)}`);
    setSelectedDateKey(inThisMonth ? today : `${nextYear}-${pad(nextMonth)}-01`);
  };

  const jumpToDate = (dateKey: string) => {
    const [nextYear, nextMonth] = dateKey.split('-').map(Number) as [number, number];
    setView({ year: nextYear, month: nextMonth });
    setSelectedDateKey(dateKey);
    setJumpOpen(false);
  };

  const openResult = (item: SearchResultItem) => {
    if (item.type === 'TASK') {
      onOpenTask(item.id);
      return;
    }
    if (item.type === 'ORG_EVENT') {
      if (item.identityId != null) {
        onOpenOrgEvent(item.identityId, resultDateKey(item) ?? selectedDateKey);
      }
      return;
    }
    const dateKey = resultDateKey(item) ?? selectedDateKey;
    onOpenEvent(item.id, dateKey, item.occurrenceDate ?? null);
  };

  /**
   * 拍照 → 上传 → 交给小安（spec §11 阶段三）。
   *
   * <p>照片先走已经建好的上传通道存下来；识别等模型接入。
   * 所以这里的失败提示只可能是「相机权限 / 上传失败」，不会假装识别成功。
   */
  const shootPhoto = async () => {
    setError(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError('需要相机权限才能拍照');
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (shot.canceled || shot.assets.length === 0) {
      return;
    }
    setPhotoBusy(true);
    try {
      const uploaded = await api.uploadImage(shot.assets[0].uri);
      onOpenAgent({ photoUrl: uploaded.url });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '照片上传失败');
    } finally {
      setPhotoBusy(false);
    }
  };

  const selectedHoliday = holidayName(holidays, selectedDateKey);

  return (
    <Screen>
      {/* 常驻搜索框：固定在顶部，不随内容滚动 */}
      <View style={[styles.searchBar, { paddingTop: insets.top + theme.spacing.sm }]}>
        <View
          style={[
            styles.searchField,
            {
              backgroundColor: theme.color.surfaceRaised,
              borderColor: theme.color.border,
              borderRadius: theme.radius.card,
            },
          ]}
        >
          <Ionicons name="search" size={16} color={theme.color.textTertiary} />
          <TextInput
            value={keyword}
            onChangeText={setKeyword}
            placeholder="搜索日程与待办"
            placeholderTextColor={theme.color.textTertiary}
            accessibilityLabel="搜索日程与待办"
            returnKeyType="search"
            style={[styles.searchInput, { color: theme.color.textPrimary }]}
          />
          {searchActive ? (
            <Pressable onPress={() => setKeyword('')} hitSlop={10} accessibilityLabel="清空搜索">
              <Ionicons name="close-circle" size={18} color={theme.color.textTertiary} />
            </Pressable>
          ) : null}
        </View>

        {/* 智能助手入口：紧挨搜索框（spec §11 阶段三的预留位） */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="智能助手"
          onPress={() => onOpenAgent()}
          style={({ pressed }) => [
            styles.agentEntry,
            {
              backgroundColor: theme.color.surfaceRaised,
              borderColor: theme.color.border,
              borderRadius: theme.radius.card,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <Ionicons name="sparkles-outline" size={18} color={theme.color.textPrimary} />
        </Pressable>
      </View>

      {searchActive ? (
        <ScrollView
          // 键盘开着时也要能直接点结果：不设这个，第一次点击只会收起键盘
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.md,
            paddingBottom: theme.spacing.xxl,
          }}
        >
          {searchError ? (
            <Text style={{ color: theme.color.danger, marginBottom: 8 }}>{searchError}</Text>
          ) : null}

          {searching && results.length === 0 ? (
            <ActivityIndicator color={theme.color.accent} style={{ marginTop: 20 }} />
          ) : null}

          {!searching && !searchError && results.length === 0 ? (
            <EmptyState title="没有找到" hint="换个关键字试试；检索范围是全部日程与待办" />
          ) : null}

          {results.length > 0 ? (
            <>
              <SectionHeader title="检索结果" caption={`共 ${results.length} 条`} />
              <ListGroup>
                {results.map((item, index) => (
                  <View key={`${item.type}-${item.id}`}>
                    {index > 0 ? <ListSeparator /> : null}
                    <ListRow
                      title={item.title}
                      subtitle={resultSubtitle(item)}
                      leading={
                        <Text
                          style={[
                            styles.typeTag,
                            { color: theme.color.textSecondary, borderColor: theme.color.border },
                          ]}
                        >
                          {resultTypeLabel(item.type)}
                        </Text>
                      }
                      trailing={
                        resultBadges(item).length > 0 ? (
                          <View style={styles.pills}>
                            {resultBadges(item).map((badge) => (
                              <Pill key={badge} text={badge} />
                            ))}
                          </View>
                        ) : undefined
                      }
                      onPress={() => openResult(item)}
                    />
                  </View>
                ))}
              </ListGroup>
            </>
          ) : null}
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: theme.spacing.md,
            paddingBottom: theme.spacing.xxl,
          }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
        >
          <MonthCalendar
            year={year}
            month={month}
            selectedDateKey={selectedDateKey}
            todayKey={today}
            eventDates={eventDates}
            holidayMarks={holidayMarks}
            onSelectDate={setSelectedDateKey}
            onChangeMonth={changeMonth}
            onToday={() => jumpToDate(today)}
          />

          <View style={[styles.divider, { backgroundColor: theme.color.border }]} />

          <View style={styles.headingRow}>
            <Text style={[styles.dayHeading, { color: theme.color.textPrimary }]}>
              {dayHeading(selectedDateKey, today)}
            </Text>
            {selectedHoliday ? <Pill text={selectedHoliday} /> : null}
          </View>

          {holidayError ? (
            <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginBottom: 8 }}>
              节假日数据加载失败，本页不显示「休 / 班」标记
            </Text>
          ) : null}

          {error ? (
            <Text style={{ color: theme.color.danger, marginBottom: 8 }}>{error}</Text>
          ) : null}

          {!loading && dayEvents.length === 0 ? (
            <EmptyState title="这天没有安排" hint="下拉可刷新" />
          ) : null}

          {dayEvents.map((item) => (
            <View key={`${item.eventId}-${item.startAt}`} style={{ marginBottom: theme.spacing.sm }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`日程-${item.title}`}
                onPress={() =>
                  onOpenEvent(item.eventId, localDateKey(item.startAt, APP_TIMEZONE), item.occurrenceDate)
                }
              >
                <Card>
                  <View style={styles.eventRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>
                        {item.title}
                      </Text>
                      <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginTop: 2 }}>
                        {formatTimeRange(item.startAt, item.endAt, item.allDay, item.timezone || APP_TIMEZONE)}
                        {item.locationName ? ` · ${item.locationName}` : ''}
                      </Text>
                    </View>
                    <View style={styles.pills}>
                      {item.recurring ? <Pill text="重复" /> : null}
                      {item.modified ? <Pill text="已改期" tone="warning" /> : null}
                    </View>
                  </View>
                </Card>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      {/* 跳到指定日期：不遮全屏、不压暗背景——它是个选择层，不是模态弹窗 */}
      {jumpOpen && !searchActive ? (
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
          {/* 滚轮（年 / 月 / 日 三列）：跨年跳日期比翻月历快得多，也不会像月历那样「点开还是一份月历」 */}
          <WheelDatePicker value={jumpDraft} onChange={setJumpDraft} />
          <View style={styles.jumpActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="回到今天"
              // 「回到今天」是个动作，不是一个滚轮微调：点了就跳过去并收起面板
              onPress={() => jumpToDate(today)}
            >
              <Text style={{ color: theme.color.accent, fontSize: 15, fontWeight: '600' }}>回到今天</Text>
            </Pressable>
            <View style={styles.jumpConfirm}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="取消"
                onPress={() => setJumpOpen(false)}
              >
                <Text style={{ color: theme.color.textSecondary, fontSize: 15 }}>取消</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="确定"
                onPress={() => jumpToDate(jumpDraft)}
              >
                <Text style={{ color: theme.color.accent, fontSize: 15 }}>确定</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {!searchActive ? (
        <>
          {/* 拍照：交给小安识别（模型未接入，照片先存下来） */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="拍照"
            onPress={() => void shootPhoto()}
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
                // 每次打开都从当前选中的日期开始，而不是上次滚到哪
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
            accessibilityLabel="新建日程"
            onPress={() => onCreateEvent(selectedDateKey)}
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
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  agentEntry: {
    width: 40,
    height: 40,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 40,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  divider: { height: 1, marginVertical: 14 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  dayHeading: { fontSize: 15, fontWeight: '600' },
  eventRow: { flexDirection: 'row', alignItems: 'center' },
  pills: { flexDirection: 'row', gap: 6 },
  typeTag: {
    width: 34,
    marginRight: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderRadius: 4,
    fontSize: 11,
    textAlign: 'center',
  },
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
    // 与新建按钮同尺寸：两个悬浮按钮一大一小会显得是没对齐的失误
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
    // 再往上排一个：与「跳到指定日期」同样间隔 12px
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
