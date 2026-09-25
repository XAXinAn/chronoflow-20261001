import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '../api/client';
import type { Task } from '../api/types';
import { ListGroup, ListRow, ListSeparator, SectionHeader } from '../components/list';
import { EmptyState, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { sortTasks } from '../domain/agenda';

const PRIORITY_LABEL: Record<Task['priority'], string | null> = {
  LOW: '低',
  NORMAL: null,
  HIGH: '重要',
  URGENT: '紧急',
};

export function TasksScreen() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await api.tasks());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const title = draft.trim();
    if (!title) {
      return;
    }
    setDraft('');
    try {
      await api.createTask({ title });
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建失败');
      setDraft(title);
    }
  };

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
              subtitle={
                task.dueAt
                  ? new Date(task.dueAt).toLocaleString('zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '待安排'
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
        }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
      >
        {/* 快速添加：整行可点，不带按钮，回车即提交 */}
        <View style={[styles.quickAdd, { borderBottomColor: theme.color.border }]}>
          <Text style={[styles.plus, { color: theme.color.textTertiary }]}>＋</Text>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => void add()}
            returnKeyType="done"
            blurOnSubmit={false}
            placeholder="添加待办…"
            accessibilityLabel="新待办标题"
            placeholderTextColor={theme.color.textTertiary}
            style={[styles.input, { color: theme.color.textPrimary }]}
          />
        </View>

        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginBottom: 12 }}>{error}</Text>
        ) : null}

        {!loading && tasks.length === 0 ? (
          <EmptyState title="还没有待办" hint="在上面输入内容，回车即可添加" />
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  quickAdd: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingBottom: 10,
    marginBottom: 20,
  },
  plus: { fontSize: 20, marginRight: 8 },
  input: { flex: 1, fontSize: 16, paddingVertical: 6 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
