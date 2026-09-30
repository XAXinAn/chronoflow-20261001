import { useCallback, useMemo, useState } from 'react';
import { userFacingError } from '../domain/errors';
import { useFocusEffect } from '@react-navigation/native';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import type { Task } from '../api/types';
import { ListGroup, ListRow, ListSeparator, SectionHeader } from '../components/list';
import { EmptyState, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { sortTasks } from '../domain/agenda';
import { APP_TIMEZONE } from '../domain/calendar';

/**
 * 截止时间的展示格式。
 *
 * 必须显式传 `timeZone`：不传就跟着**设备时区**走，而这台设备一旦不是 Asia/Shanghai
 * （例如模拟器默认 UTC），同一时刻在日历页显示 10:00、在待办页却显示 02:00——
 * 两页自相矛盾，用户只会觉得数据错了。
 */
const DUE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: APP_TIMEZONE,
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const PRIORITY_LABEL: Record<Task['priority'], string | null> = {
  LOW: '低',
  NORMAL: null,
  HIGH: '重要',
  URGENT: '紧急',
};

export function TasksScreen({
  onCreateTask,
  onOpenTask,
}: {
  onCreateTask: () => void;
  onOpenTask: (taskId: number) => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await api.tasks());
    } catch (cause) {
      setError(userFacingError(cause, '加载失败'));
    } finally {
      setLoading(false);
    }
  }, [api]);

  // 从编辑页返回时重新拉取，新建的待办才会立刻出现
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const toggle = async (task: Task) => {
    // 乐观更新：先改本地状态，失败再回滚，避免勾选时有网络等待感
    const next = task.status === 'DONE' ? 'TODO' : 'DONE';
    setTasks((current) => current.map((item) => (item.id === task.id ? { ...item, status: next } : item)));
    try {
      await api.completeTask(task.id, next === 'DONE');
    } catch {
      await load();
    }
  };

  const ordered = useMemo(() => sortTasks(tasks), [tasks]);
  const open = ordered.filter((task) => task.status !== 'DONE');
  const done = ordered.filter((task) => task.status === 'DONE');
  const now = Date.now();

  const renderGroup = (items: Task[]) => (
    <ListGroup>
      {items.map((task, index) => {
        const isDone = task.status === 'DONE';
        const overdue = !isDone && task.dueAt !== null && Date.parse(task.dueAt) < now;
        const priority = PRIORITY_LABEL[task.priority];
        return (
          <View key={task.id}>
            {index > 0 ? <ListSeparator inset={52} /> : null}
            <ListRow
              title={task.title}
              strikethrough={isDone}
              // 点整行进编辑；左侧复选框自己拦截点击，互不干扰
              onPress={() => onOpenTask(task.id)}
              subtitle={
                task.dueAt ? DUE_FORMATTER.format(new Date(task.dueAt)) : '待安排'
              }
              leading={
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isDone }}
                  accessibilityLabel={task.title}
                  hitSlop={8}
                  onPress={() => void toggle(task)}
                  style={{ marginRight: 12 }}
                >
                  <View
                    style={[
                      styles.checkbox,
                      {
                        borderColor: isDone ? theme.color.accent : theme.color.border,
                        backgroundColor: isDone ? theme.color.accent : 'transparent',
                      },
                    ]}
                  >
                    {isDone ? (
                      <Text style={{ color: theme.color.accentContrast, fontSize: 12, lineHeight: 16 }}>
                        ✓
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              }
              trailing={
                priority ? (
                  <Text
                    style={{
                      color: task.priority === 'URGENT' ? theme.color.danger : theme.color.textSecondary,
                      fontSize: 12,
                    }}
                  >
                    {priority}
                  </Text>
                ) : null
              }
            />
            {overdue ? (
              <View style={{ paddingHorizontal: 52, paddingBottom: 10, marginTop: -6 }}>
                <Text style={{ color: theme.color.danger, fontSize: 12 }}>已逾期</Text>
              </View>
            ) : null}

            {/* 关联的日程单独占一行并带图标：塞在副标题文字里太容易看漏，
                而「这条待办是为哪个安排服务的」恰恰是最该一眼看到的信息 */}
            {task.eventTitle ? (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 52,
                  paddingBottom: 10,
                  marginTop: -6,
                }}
              >
                <Ionicons name="calendar-outline" size={12} color={theme.color.textTertiary} />
                <Text
                  numberOfLines={1}
                  style={{ color: theme.color.textSecondary, fontSize: 12, marginLeft: 4, flex: 1 }}
                >
                  {task.eventTitle}
                </Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </ListGroup>
  );

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.md,
          paddingTop: insets.top + theme.spacing.sm,
          paddingBottom: theme.spacing.xxl,
          // 空态要能撑满剩余高度才能垂直居中，否则它会贴在顶部很突兀
          flexGrow: 1,
        }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
      >
        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginBottom: 12 }}>{error}</Text>
        ) : null}

        {!loading && tasks.length === 0 ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState title="还没有待办" hint="点右下角 ＋ 新建" />
          </View>
        ) : null}

        {open.length > 0 ? (
          <View style={{ marginBottom: theme.spacing.lg }}>
            <SectionHeader title="待办" caption={`${open.length} 条`} />
            {renderGroup(open)}
          </View>
        ) : null}

        {done.length > 0 ? (
          <View style={{ marginBottom: theme.spacing.lg }}>
            <SectionHeader title="已完成" caption={`${done.length} 条`} />
            {renderGroup(done)}
          </View>
        ) : null}
      </ScrollView>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="新建待办"
        onPress={onCreateTask}
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
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
});
