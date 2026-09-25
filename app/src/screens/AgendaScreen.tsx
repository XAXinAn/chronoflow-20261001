import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { EventOccurrence } from '../api/types';
import { ApiError } from '../api/client';
import { Card, EmptyState, Pill, Screen } from '../components/ui';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import { formatDayLabel, formatTimeRange, groupOccurrences, localDateKey } from '../domain/agenda';

const LOOKAHEAD_DAYS = 14;

export function AgendaScreen() {
  const theme = useAppTheme();
  const { api } = useRuntime();
  const { session } = useAppSessionState();
  const timeZone = 'Asia/Shanghai';

  const [items, setItems] = useState<EventOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const end = new Date(now.getTime() + LOOKAHEAD_DAYS * 86_400_000);
      setItems(await api.eventsInRange(now.toISOString(), end.toISOString()));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const sections = useMemo(() => groupOccurrences(items, timeZone), [items]);
  const todayKey = localDateKey(new Date().toISOString(), timeZone);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.md }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
      >
        <Text style={[styles.title, { color: theme.color.textPrimary }]}>我的日程</Text>
        <Text style={{ color: theme.color.textSecondary, marginBottom: theme.spacing.md }}>
          {session?.identityType === 'ORG_MEMBER' ? '个人身份' : (session?.nickname ?? '')} · 未来 {LOOKAHEAD_DAYS} 天
        </Text>

        {error ? <Text style={{ color: theme.color.danger, marginBottom: theme.spacing.md }}>{error}</Text> : null}
        {!loading && sections.length === 0 ? (
          <EmptyState title="近期没有安排" hint="在个人日历里新建一条日程试试" />
        ) : null}

        {sections.map((section) => (
          <View key={section.date} style={{ marginBottom: theme.spacing.lg }}>
            <Text style={[styles.sectionTitle, { color: theme.color.textSecondary }]}>
              {formatDayLabel(section.date, todayKey)} · {section.date}
            </Text>
            {section.items.map((item) => (
              <View key={`${item.eventId}-${item.startAt}`} style={{ marginBottom: theme.spacing.sm }}>
                <Card>
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>
                        {item.title}
                      </Text>
                      <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginTop: 2 }}>
                        {formatTimeRange(item.startAt, item.endAt, item.allDay, item.timezone || timeZone)}
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
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '600', marginBottom: 4 },
  sectionTitle: { fontSize: 13, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center' },
  pills: { flexDirection: 'row', gap: 6 },
});
