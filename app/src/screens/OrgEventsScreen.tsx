import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { OrgEvent, ReceiptStatus } from '../api/types';
import { ApiError } from '../api/client';
import { MonthCalendar } from '../components/MonthCalendar';
import { Card, EmptyState, GhostButton, Pill, Screen } from '../components/ui';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import { dayHeading, formatTimeRange, localDateKey, receiptLabel } from '../domain/agenda';
import { APP_TIMEZONE, buildMonthGrid, dateKeyToIso } from '../domain/calendar';

const RECEIPT_TONE: Record<ReceiptStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  PENDING: 'warning',
  ACCEPTED: 'success',
  DECLINED: 'neutral',
  COMPLETED: 'success',
};

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
 * 没有新建入口——下发权在部门管理员 / 组织管理员手里，不在成员端。
 */
export function OrgEventsScreen() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();
  const { session } = useAppSessionState();

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

  const isOrgIdentity = session?.identityType === 'ORG_MEMBER';

  const load = useCallback(async () => {
    if (!isOrgIdentity) {
      setLoading(false);
      return;
    }
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
  }, [api, isOrgIdentity, year, month]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const submitReceipt = async (event: OrgEvent, status: ReceiptStatus) => {
    try {
      await api.submitReceipt(event.eventId, status);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '回执提交失败');
    }
  };

  if (!isOrgIdentity) {
    return (
      <Screen>
        <View style={{ padding: theme.spacing.md, paddingTop: insets.top + theme.spacing.sm }}>
          <EmptyState title="当前是个人身份" hint="在「我的」里切换到组织身份后即可查看组织日程" />
        </View>
      </Screen>
    );
  }

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
                    {item.location ? ` · ${item.location}` : ''}
                  </Text>
                </View>
                <View style={styles.pills}>
                  {/* 组织日程对成员只读，这里只暴露「我的回执」状态 */}
                  {item.receiptStatus ? (
                    <Pill text={receiptLabel(item.receiptStatus)} tone={RECEIPT_TONE[item.receiptStatus]} />
                  ) : null}
                </View>
              </View>

              {item.requireReceipt ? (
                <View style={[styles.actions, { marginTop: theme.spacing.sm }]}>
                  <View style={styles.action}>
                    <GhostButton title="参加" onPress={() => void submitReceipt(item, 'ACCEPTED')} />
                  </View>
                  <View style={styles.action}>
                    <GhostButton title="不参加" onPress={() => void submitReceipt(item, 'DECLINED')} />
                  </View>
                  <View style={styles.action}>
                    <GhostButton title="已完成" onPress={() => void submitReceipt(item, 'COMPLETED')} />
                  </View>
                </View>
              ) : null}
            </Card>
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  divider: { height: 1, marginVertical: 14 },
  dayHeading: { fontSize: 15, fontWeight: '600', marginBottom: 10 },
  eventRow: { flexDirection: 'row', alignItems: 'center' },
  pills: { flexDirection: 'row', gap: 6 },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1 },
});
