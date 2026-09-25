import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { OrgEvent, ReceiptStatus } from '../api/types';
import { ApiError } from '../api/client';
import { Card, EmptyState, GhostButton, Pill, Screen } from '../components/ui';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import { formatTimeRange, groupOrgEvents, receiptLabel } from '../domain/agenda';

const WINDOW_DAYS = 30;

const RECEIPT_TONE: Record<ReceiptStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  PENDING: 'warning',
  ACCEPTED: 'success',
  DECLINED: 'neutral',
  COMPLETED: 'success',
};

export function OrgEventsScreen() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();
  const { session } = useAppSessionState();
  const timeZone = 'Asia/Shanghai';

  const [items, setItems] = useState<OrgEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const end = new Date(now.getTime() + WINDOW_DAYS * 86_400_000);
      setItems(await api.orgEvents(now.toISOString(), end.toISOString()));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitReceipt = async (event: OrgEvent, status: ReceiptStatus) => {
    try {
      await api.submitReceipt(event.eventId, status);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '回执提交失败');
    }
  };

  if (session?.identityType !== 'ORG_MEMBER') {
    return (
      <Screen>
        <View style={{ padding: theme.spacing.md, paddingTop: insets.top + theme.spacing.sm }}>
          <EmptyState title="当前是个人身份" hint="在「我的」里切换到组织身份后即可查看组织日程" />
        </View>
      </Screen>
    );
  }

  const sections = groupOrgEvents(items, timeZone);
  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.md,
          paddingTop: insets.top + theme.spacing.sm,
        }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
      >
        {error ? <Text style={{ color: theme.color.danger, marginBottom: theme.spacing.sm }}>{error}</Text> : null}
        {!loading && sections.length === 0 ? <EmptyState title="暂无组织日程" /> : null}

        {sections.map((section) => (
          <View key={section.date} style={{ marginBottom: theme.spacing.lg }}>
            <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginBottom: 8 }}>
              {section.date}
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
                      {/* 组织日程对成员是只读的，这里只允许改动自己的回执 */}
                      {item.receiptStatus ? (
                        <View style={{ marginTop: theme.spacing.xs, flexDirection: 'row' }}>
                          <Pill
                            text={receiptLabel(item.receiptStatus)}
                            tone={RECEIPT_TONE[item.receiptStatus]}
                          />
                        </View>
                      ) : null}
                    </View>
                  </View>

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
  row: { flexDirection: 'row', alignItems: 'center' },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1 },
});
