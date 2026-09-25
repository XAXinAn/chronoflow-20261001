import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Task } from '../api/types';
import { ApiError } from '../api/client';
import { Card, EmptyState, Pill, PrimaryButton, Screen } from '../components/ui';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { sortTasks } from '../domain/agenda';

export function TasksScreen() {
  const theme = useAppTheme();
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
    try {
      await api.createTask({ title });
      setDraft('');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建失败');
    }
  };

  const toggle = async (task: Task) => {
    // 乐观更新：先改本地状态，失败后再回滚，避免等待网络造成卡顿感
    const next = task.status === 'DONE' ? 'TODO' : 'DONE';
    setTasks((current) =>
      current.map((item) => (item.id === task.id ? { ...item, status: next } : item)),
    );
    try {
      await api.completeTask(task.id, next === 'DONE');
    } catch {
      await load();
    }
  };

  const ordered = sortTasks(tasks);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.md }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
      >
        <Text style={[styles.title, { color: theme.color.textPrimary }]}>待办</Text>
        <Text style={{ color: theme.color.textSecondary, marginBottom: theme.spacing.md }}>
          共 {tasks.length} 条，未完成 {tasks.filter((task) => task.status !== 'DONE').length} 条
        </Text>

        <View style={styles.addRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="添加一条待办"
            accessibilityLabel="新待办标题"
            placeholderTextColor={theme.color.textTertiary}
            style={[
              styles.input,
              {
                color: theme.color.textPrimary,
                borderColor: theme.color.border,
                borderRadius: theme.radius.input,
                backgroundColor: theme.color.surfaceRaised,
              },
            ]}
          />
          <View style={{ width: 88, marginLeft: 12 }}>
            <PrimaryButton title="添加" onPress={() => void add()} disabled={!draft.trim()} />
          </View>
        </View>

        {error ? <Text style={{ color: theme.color.danger, marginBottom: theme.spacing.sm }}>{error}</Text> : null}
        {!loading && ordered.length === 0 ? <EmptyState title="还没有待办" hint="上面输入框可以直接添加" /> : null}

        {ordered.map((task) => {
          const done = task.status === 'DONE';
          return (
            <Pressable
              key={task.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: done }}
              onPress={() => void toggle(task)}
              style={{ marginBottom: theme.spacing.sm }}
            >
              <Card>
                <View style={styles.row}>
                  <View
                    style={[
                      styles.checkbox,
                      { borderColor: done ? theme.color.success : theme.color.border },
                    ]}
                  >
                    {done ? (
                      <Text style={{ color: theme.color.success, fontSize: 12, lineHeight: 16 }}>✓</Text>
                    ) : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{
                        color: done ? theme.color.textTertiary : theme.color.textPrimary,
                        fontSize: 16,
                        textDecorationLine: done ? 'line-through' : 'none',
                      }}
                    >
                      {task.title}
                    </Text>
                    <Text style={{ color: theme.color.textSecondary, fontSize: 12, marginTop: 2 }}>
                      {task.dueAt ? new Date(task.dueAt).toLocaleString('zh-CN') : '待安排'}
                    </Text>
                  </View>
                  {task.priority !== 'NORMAL' ? (
                    <Pill
                      text={task.priority === 'URGENT' ? '紧急' : task.priority === 'HIGH' ? '重要' : '低'}
                      tone={task.priority === 'URGENT' ? 'danger' : task.priority === 'HIGH' ? 'warning' : 'neutral'}
                    />
                  ) : null}
                </View>
              </Card>
            </Pressable>
          );
        })}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '600', marginBottom: 4 },
  addRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  input: { flex: 1, height: 48, borderWidth: 1, paddingHorizontal: 12, fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center' },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 1,
    borderRadius: 6,
    marginRight: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
