import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { userFacingError } from '../domain/errors';
import { useFocusEffect } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { EventOccurrence, HolidayResponse, SearchResultItem } from '../api/types';
import { draftsFromItems, type RecognizedDraft } from '../domain/vision';
import { askPermission } from '../components/permission';
import { MonthCalendar } from '../components/MonthCalendar';
import { WheelDatePicker } from '../components/WheelDatePicker';
import { ListGroup, ListRow, ListSeparator, SectionHeader } from '../components/list';
import { Card, EmptyState, Pill, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import {
  dayHeading,
  formatEventTime,
  localDateKey,
  locationLabel,
} from '../domain/agenda';
import { APP_TIMEZONE, buildMonthGrid, dateKeyToIso } from '../domain/calendar';
import { holidayName, toHolidayMarks, yearsSpanned } from '../domain/holiday';
import { resultBadges, resultDateKey, resultSubtitle, resultTypeLabel } from '../domain/search';
import { DeviceRecognitionUnavailable, ocrImageText } from '../vision/onDevice';

/** 检索防抖：每敲一个字就发一次请求既费流量，也会让结果闪。 */
const SEARCH_DEBOUNCE_MS = 300;

/** 「上传图片」弹层滑上来的行程（足够把两张卡片完全推到屏幕外）。 */
const SHEET_TRAVEL = 340;

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
  onReviewDrafts,
}: {
  onCreateEvent: (dateKey: string) => void;
  onOpenEvent: (eventId: number, dateKey: string, occurrenceDate: string | null) => void;
  onOpenTask: (taskId: number) => void;
  /** 组织日程结果：切到那个组织的视图并选中那天（只读，进不了个人编辑页） */
  onOpenOrgEvent: (identityId: number, dateKey: string) => void;
  /** 图片识别出的日程草稿：进确认页补日期 / 改标题，用户确认后再落库（spec §4.1.9） */
  onReviewDrafts: (drafts: RecognizedDraft[]) => void;
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
  /** 正在识别（选图 → 端侧 OCR → 云端解析）：期间按钮显示「识别中…」并禁用 */
  const [recognizing, setRecognizing] = useState(false);
  /** 「上传图片」来源选择层：相册上传 / 拍照上传（取消单独一条，见 JSX） */
  const [sourceOpen, setSourceOpen] = useState(false);
  /**
   * 弹层的动画进度：0 = 完全收起（在屏幕外），1 = 完全展开。
   *
   * <p>用同一个值同时驱动「卡片上滑」与「遮罩淡入」——两者分开算很容易在快速
   * 开合时跑偏（卡片已经下去了、遮罩还留着）。收起动画结束后才卸载，
   * 否则直接 setState(false) 会让卡片"啪"地消失，没有滑下去的过程。
   */
  const sheetAnim = useRef(new Animated.Value(0)).current;

  const openSourceSheet = useCallback(() => {
    setSourceOpen(true);
    sheetAnim.setValue(0);
    Animated.timing(sheetAnim, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [sheetAnim]);

  const closeSourceSheet = useCallback(() => {
    Animated.timing(sheetAnim, {
      toValue: 0,
      duration: 160,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setSourceOpen(false);
      }
    });
  }, [sheetAnim]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
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
      setError(userFacingError(cause, '加载失败'));
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
            setSearchError(userFacingError(cause, '检索失败'));
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
    () => new Set(occurrences.map((item) => localDateKey(item.at, APP_TIMEZONE))),
    [occurrences],
  );
  const holidayMarks = useMemo(() => toHolidayMarks(holidays), [holidays]);

  const dayEvents = useMemo(
    () =>
      occurrences
        .filter((item) => localDateKey(item.at, APP_TIMEZONE) === selectedDateKey)
        .sort((a, b) => a.at.localeCompare(b.at)),
    [occurrences, selectedDateKey],
  );

  /**
   * 「点击上传图片，一键添加日程」：选来源 → 选图/拍照 → 端侧 OCR → 云端解析 → 确认页。
   *
   * <p>**图片不出手机**：端侧 OCR（原生模块，只有开发版 / 正式版里注册得上）先把图片转成文字，
   * 发到服务端的只有**文字**；Expo Go 下 OCR 拿不到原生模块会抛 DeviceRecognitionUnavailable，
   * 这里如实说明，**不静默改成上传图片**——「图片不出手机」正是这个功能的承诺。
   *
   * <p>解析结果交给确认页：每条可改标题 / 补日期 / 删除，用户确认后才逐条写进日历。
   * 所以这里**只负责识别与跳转**，不直接落库（模型会看错，直接写进日历比看错更糟）。
   */
  const uploadImage = useCallback(async (source: 'library' | 'camera') => {
    if (recognizing) {
      return;
    }
    closeSourceSheet();
    // 先说明用途再申请系统权限；拒绝就只是不识别，别的功能照常用（规范 §四）
    if (!(await askPermission(source === 'camera' ? 'camera' : 'photo'))) {
      return;
    }
    const picked = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 })
      : await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        // 不开 allowsEditing：AOSP 那个裁剪页的确认按钮在模拟器上渲染不出来（实测）
        quality: 0.8,
      });
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }
    setRecognizing(true);
    try {
      // ① 端侧 OCR：中文通知这类图，手机本地的 ML Kit 又准又不花钱
      const ocrText = await ocrImageText(picked.assets[0].uri);
      if (!ocrText.trim()) {
        Alert.alert('没识别出文字', '这张图里没有识别出可用的文字，换一张再试。');
        return;
      }

      // ② 云端解析：「一段通知里有几件要做的事、哪句是时间」是模型的长处。
      //    端侧小模型这条路已下线（0.5B 抽一份通知不够用，且把 APK 撑到 570MB）。
      const parsed = await api.parseScheduleText({
        text: ocrText,
        today,
        timezone: APP_TIMEZONE,
      });
      const drafts = draftsFromItems(parsed.items);
      console.log(`[vision] 解析完成：草稿 ${drafts.length} 条`);
      if (drafts.length === 0) {
        // 如实说「没有要做的事」，而不是「识别失败」——两者对用户是两件事
        Alert.alert('没找到要做的事', '这张图里没有找到要做的事。');
        return;
      }
      // ③ 交给确认页：补日期、改标题，用户确认后才写
      onReviewDrafts(drafts);
    } catch (cause) {
      if (cause instanceof DeviceRecognitionUnavailable) {
        Alert.alert(
          '端侧识别还没就绪',
          `${cause.message}\n\n识别全程在手机本地完成，不会把图片上传到服务器。`,
        );
      } else {
        Alert.alert('识别失败', userFacingError(cause, '识别没成功，稍后再试'));
      }
    } finally {
      setRecognizing(false);
    }
  }, [closeSourceSheet, onReviewDrafts, recognizing, api, today]);

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

          {/*
            日历下方的文字按钮：点击上传图片 → 一键添加日程（spec §4.1.9）。
            链路：选来源（相册/拍照）→ 端侧 OCR（图片不出手机）→ 云端解析文字 →
            确认页（补日期 / 改标题）→ 逐条写进日历。见 src/vision/onDevice.ts 与
            src/screens/EventImportScreen.tsx。
          */}
          {/* 按钮上下各一条横线：把它做成月历与当日日程之间独立的一条带 */}
          <View style={[styles.divider, { backgroundColor: theme.color.border }]} />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="点击上传图片，一键添加日程"
            accessibilityState={{ busy: recognizing, disabled: recognizing }}
            disabled={recognizing}
            hitSlop={8}
            onPress={openSourceSheet}
            style={styles.uploadEntry}
          >
            <Text style={{ color: theme.color.accent, fontSize: 14, fontWeight: '600' }}>
              {recognizing ? '识别中…' : '点击上传图片，一键添加日程'}
            </Text>
          </Pressable>

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
            <View key={`${item.eventId}-${item.at}`} style={{ marginBottom: theme.spacing.sm }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`日程-${item.title}`}
                onPress={() =>
                  onOpenEvent(item.eventId, localDateKey(item.at, APP_TIMEZONE), item.occurrenceDate)
                }
              >
                <Card>
                  <View style={styles.eventRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>
                        {item.title}
                      </Text>
                      <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginTop: 2 }}>
                        {[
                          formatEventTime(item.at, item.timezone || APP_TIMEZONE),
                          locationLabel(item.locationName, item.locationDetail),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
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

      {/*
        「从哪里选图」：自绘的底部弹层，不用 Alert —— Android 的 AlertDialog 会把三个按钮
        硬排成一行（相册上传单独在左、拍照上传和取消挤在右），而这两条选项本该是一组、
        「取消」该单独一条。样式与页面上「跳到指定日期」那个层保持一致（黑白、细边框）。
      */}
      {sourceOpen ? (
        <View style={styles.sheetOverlay}>
          <Animated.View
            style={[
              styles.sheetBackdrop,
              {
                // 遮罩随同一个进度淡入淡出，不做成"唰"地整块出现
                opacity: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
              },
            ]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭"
              onPress={closeSourceSheet}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
          {/* 整组从屏幕外滑上来：位移与遮罩共用 sheetAnim */}
          <Animated.View
            style={{
              transform: [
                {
                  translateY: sheetAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [SHEET_TRAVEL, 0],
                  }),
                },
              ],
              opacity: sheetAnim,
            }}
          >
            <View
              style={[
                styles.sheetCard,
                {
                  backgroundColor: theme.color.surfaceRaised,
                  borderColor: theme.color.border,
                  borderRadius: theme.radius.card,
                },
              ]}
              accessibilityViewIsModal
            >
              <Text style={[styles.sheetTitle, { color: theme.color.textTertiary }]}>上传图片</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="相册上传"
                onPress={() => void uploadImage('library')}
                style={styles.sheetRow}
              >
                <Ionicons name="images-outline" size={20} color={theme.color.textPrimary} />
                <Text style={{ color: theme.color.textPrimary, fontSize: 16 }}>相册上传</Text>
              </Pressable>
              <View style={[styles.sheetDivider, { backgroundColor: theme.color.border }]} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="拍照上传"
                onPress={() => void uploadImage('camera')}
                style={styles.sheetRow}
              >
                <Ionicons name="camera-outline" size={20} color={theme.color.textPrimary} />
                <Text style={{ color: theme.color.textPrimary, fontSize: 16 }}>拍照上传</Text>
              </Pressable>
            </View>
            {/* 取消单独一张，不跟上面两条挤在一起 */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="取消"
              onPress={closeSourceSheet}
              style={[
                styles.sheetCard,
                styles.sheetCancel,
                {
                  backgroundColor: theme.color.surfaceRaised,
                  borderColor: theme.color.border,
                  borderRadius: theme.radius.card,
                },
              ]}
            >
              <Text style={{ color: theme.color.textSecondary, fontSize: 16 }}>取消</Text>
            </Pressable>
          </Animated.View>
        </View>
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
  /**
   * 日历下方的文字按钮：上传图片 → 识别日程（spec §4.1.9）。
   * 上下各有一条 divider 的 marginVertical 撑着，这里不再自己加外边距，
   * 免得按钮在两线之间偏下。
   */
  uploadEntry: { alignItems: 'center', paddingVertical: 10 },
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
  /** 「从哪里选图」层：整屏盖住，底部两张卡片（选项一组 + 取消单独一张） */
  sheetOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    zIndex: 20,
  },
  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  sheetCard: {
    marginHorizontal: 16,
    borderWidth: 1,
    paddingVertical: 4,
    elevation: 8,
  },
  sheetTitle: { fontSize: 13, fontWeight: '600', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14 },
  sheetDivider: { height: 1, marginHorizontal: 16 },
  /** 取消单独一张卡片，和上面两条拉开距离 —— 它不是第三个动作，是「不选」 */
  sheetCancel: { alignItems: 'center', marginTop: 8, marginBottom: 24, paddingVertical: 14 },
});
