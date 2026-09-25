import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '../api/client';
import { Card, EmptyState, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { dayHeading, formatTimeRange, localDateKey } from '../domain/agenda';
import { APP_TIMEZONE } from '../domain/calendar';

export interface PickedEvent {
  eventId: number;
  title: string;
}

/** 候选窗口：往后 120 天。关联的是「即将发生的事」，拉太远只会让列表难用。 */
const WINDOW_DAYS = 120;

/**
 * 选择要关联的日程（spec §4.1.6）。
 *
 * 关联在**待办侧**建立，所以入口在待办编辑页，这里只负责挑一条日程。
 * 列表按天分组，只展示未发生或正在发生的日程——已经过去的事没什么好关联的。
 */
export function EventPickerScreen({
  onCancel,
  onPick,
}: {
  onCancel: () => void;
  onPick: (event: PickedEvent | null) => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();

  const [items, setItems] = useState<{ eventId: number; title: string; startAt: string; endAt: string; allDay: boolean; timezone: string; locationName: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const end = new Date(now.getTime() + WINDOW_DAYS * 86_400_000);
      setItems(await api.eventsInRange(now.toISOString(), end.toISOString()));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载日程失败');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // 按天分组展示，和日历页的口径保持一致
  const grouped = items.reduce<Record<string, typeof items>>((acc, item) => {
    const key = localDateKey(item.startAt, APP_TIMEZONE);
    (acc[key] ??= []).push(item);
    return acc;
  }, {});
  const today = localDateKey(new Date().toISOString(), APP_TIMEZONE);

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
        <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>关联日程</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="不关联" onPress={() => onPick(null)} hitSlop={10}>
          <Text style={{ color: theme.color.textSecondary, fontSize: 16 }}>不关联</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: theme.spacing.md, paddingBottom: theme.spacing.xxl }}>
        {loading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator color={theme.color.accent} />
          </View>
        ) : null}

        {!loading && items.length === 0 && !error ? (
          <EmptyState title="近期没有可关联的日程" hint="先建一条日程再来关联" />
        ) : null}

        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginBottom: theme.spacing.sm }}>{error}</Text>
        ) : null}

        {Object.entries(grouped).map(([dateKey, dayItems]) => (
          <View key={dateKey} style={{ marginBottom: theme.spacing.lg }}>
            <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginBottom: 8 }}>
              {dayHeading(dateKey, today)}
            </Text>
            {dayItems.map((item) => (
              <Pressable
                key={`${item.eventId}-${item.startAt}`}
                accessibilityRole="button"
                accessibilityLabel={`日程-${item.title}`}
                onPress={() => onPick({ eventId: item.eventId, title: item.title })}
                style={{ marginBottom: theme.spacing.sm }}
              >
                <Card>
                  <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>
                    {item.title}
                  </Text>
                  <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginTop: 2 }}>
                    {formatTimeRange(item.startAt, item.endAt, item.allDay, item.timezone || APP_TIMEZONE)}
                    {item.locationName ? ` · ${item.locationName}` : ''}
                  </Text>
                </Card>
              </Pressable>
            ))}
          </View>
        ))}
      </ScrollView>
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
});
