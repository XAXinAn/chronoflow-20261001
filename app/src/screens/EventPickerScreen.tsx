import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '../api/client';
import { Card, EmptyState, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { dayHeading, formatTimeRange, localDateKey } from '../domain/agenda';
import { APP_TIMEZONE } from '../domain/calendar';

/** 输入停顿多久才算「搜」：与日历页检索一致，打字过程中不发请求。 */
const SEARCH_DEBOUNCE_MS = 350;

export interface PickedEvent {
  eventId: number;
  title: string;
}

/**
 * 选择要关联的日程（spec §4.1.6）。
 *
 * 关联在**待办侧**建立，所以入口在待办编辑页，这里只负责挑一条日程。
 * 候选是**我的全部日程**（`GET /events/all`，spec §4.1.6）：不受时间窗口限制
 * ——「上个月那个会」也可能要挂一条待办上去 —— 顶部常驻搜索框按标题/描述/地点检索。
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
  const [keyword, setKeyword] = useState('');
  const [error, setError] = useState<string | null>(null);

  /**
   * 拉候选。搜索走服务端（不是本地过滤）：全部日程可能很多，
   * 本地只过滤已加载的那 200 条就等于「搜不到更早的日程」。
   */
  useEffect(() => {
    const trimmed = keyword.trim();
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.allEvents(trimmed || undefined);
          if (!cancelled) {
            setItems(result);
          }
        } catch (cause) {
          if (!cancelled) {
            setItems([]);
            setError(cause instanceof ApiError ? cause.message : '加载日程失败');
          }
        } finally {
          if (!cancelled) {
            setLoading(false);
          }
        }
      })();
    }, trimmed ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, keyword]);

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
        {/* 候选是全部日程，可能很长：搜索框常驻顶部，与选人页同一个交互 */}
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
          <TextInput
            value={keyword}
            onChangeText={setKeyword}
            placeholder="搜索日程（标题 / 备注 / 地点）"
            placeholderTextColor={theme.color.textTertiary}
            accessibilityLabel="搜索日程"
            style={{ color: theme.color.textPrimary, flex: 1, fontSize: 15, padding: 0 }}
          />
          {keyword ? (
            <Pressable accessibilityLabel="清空搜索" onPress={() => setKeyword('')} hitSlop={10}>
              <Text style={{ color: theme.color.textTertiary, fontSize: 14 }}>✕</Text>
            </Pressable>
          ) : null}
        </View>

        {loading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator color={theme.color.accent} />
          </View>
        ) : null}

        {!loading && items.length === 0 && !error ? (
          <EmptyState
            title={keyword.trim() ? '没有匹配的日程' : '还没有日程可关联'}
            hint={keyword.trim() ? '换个关键词试试' : '先去日历页新建一条日程'}
          />
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
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
