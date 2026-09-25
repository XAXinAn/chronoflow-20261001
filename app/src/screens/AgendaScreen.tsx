import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '../api/client';
import type { EventOccurrence } from '../api/types';
import { EventEditorModal } from '../components/EventEditorModal';
import { MonthCalendar } from '../components/MonthCalendar';
import { Card, EmptyState, Pill, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { dayHeading, formatTimeRange, localDateKey } from '../domain/agenda';
import { APP_TIMEZONE, buildMonthGrid, dateKeyToIso } from '../domain/calendar';
import { buildCreatePayload, type EventDraft } from '../domain/eventDraft';

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function todayKey(): string {
  return localDateKey(new Date().toISOString(), APP_TIMEZONE);
}

/**
 * 首页：日历 + 当日日程（spec §7.6 黑白极简）。
 *
 * 日历展示整月的日程分布（有日程的日子带圆点），下方是该日的详细日程。
 */
export function AgendaScreen() {
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const grid = buildMonthGrid(year, month);
      // 按整个网格范围查询（含上/下月补位），这样相邻月份的格子也能显示圆点
      setOccurrences(
        await api.eventsInRange(dateKeyToIso(grid.startDateKey), dateKeyToIso(grid.endDateKey, true)),
      );
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [api, year, month]);

  useEffect(() => {
    void load();
  }, [load]);

  const eventDates = useMemo(
    () => new Set(occurrences.map((item) => localDateKey(item.startAt, APP_TIMEZONE))),
    [occurrences],
  );

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

  const createEvent = async (draft: EventDraft) => {
    setSaving(true);
    setEditorError(null);
    try {
      // 日期取当前选中的那天，无需在弹窗里再选一次
      await api.createEvent(buildCreatePayload(selectedDateKey, draft));
      setEditorVisible(false);
      await load();
    } catch (cause) {
      setEditorError(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.md,
          // 去掉顶部标题栏后，内容紧贴屏幕顶边，需要补安全区避免压到状态栏
          paddingTop: insets.top + theme.spacing.sm,
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
          onSelectDate={setSelectedDateKey}
          onChangeMonth={changeMonth}
        />

        <View style={[styles.divider, { backgroundColor: theme.color.border }]} />

        <Text style={[styles.dayHeading, { color: theme.color.textPrimary }]}>
          {dayHeading(selectedDateKey, today)}
        </Text>

        {error ? <Text style={{ color: theme.color.danger, marginBottom: 8 }}>{error}</Text> : null}

        {!loading && dayEvents.length === 0 ? (
          <EmptyState title="这天没有安排" hint="下拉可刷新" />
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
                    {item.location ? ` · ${item.location}` : ''}
                  </Text>
                </View>
                <View style={styles.pills}>
                  {item.recurring ? <Pill text="重复" /> : null}
                  {item.modified ? <Pill text="已改期" tone="warning" /> : null}
                </View>
              </View>
            </Card>
          </View>
        ))}
      </ScrollView>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="新建日程"
        onPress={() => setEditorVisible(true)}
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

      <EventEditorModal
        visible={editorVisible}
        dateKey={selectedDateKey}
        saving={saving}
        error={editorError}
        onCancel={() => setEditorVisible(false)}
        onSubmit={(draft) => void createEvent(draft)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  divider: { height: 1, marginVertical: 14 },
  dayHeading: { fontSize: 15, fontWeight: '600', marginBottom: 10 },
  eventRow: { flexDirection: 'row', alignItems: 'center' },
  pills: { flexDirection: 'row', gap: 6 },
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
});
