import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { ApiError } from '../api/client';
import { Card, Screen } from '../components/ui';
import { EditorHeader, FormInput, FormRow, FormRowText, FormTextArea, SegmentedControl } from '../components/form';
import { useAppTheme, useRuntime } from '../context/AppContext';
import {
  TASK_PRIORITY_OPTIONS,
  buildCreateTaskPayload,
  buildUpdateTaskPayload,
  draftFromTask,
  emptyTaskDraft,
  validateTaskDraft,
  type TaskDraft,
} from '../domain/taskDraft';

/**
 * 新建 / 编辑待办：**独立整页**（spec §4.1.5）。
 *
 * 新建与编辑共用同一页：字段一致，分两页只会让两边逐渐长歪。
 * 待办比日程多一个特性——截止时间可以不存在（归入「待安排」），
 * 所以用显式开关表达，而不是让用户去猜空输入框是什么意思。
 */
export function TaskEditorScreen({
  todayKey,
  taskId,
  onCancel,
  onSaved,
}: {
  todayKey: string;
  /** 传了就是编辑已有待办 */
  taskId?: number;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const theme = useAppTheme();
  const { api } = useRuntime();
  const isEdit = typeof taskId === 'number';

  const [draft, setDraft] = useState<TaskDraft>(() => emptyTaskDraft(todayKey));
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isEdit || taskId === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const task = await api.taskDetail(taskId);
        if (!cancelled) {
          setDraft(draftFromTask(task, todayKey));
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof ApiError ? cause.message : '加载待办失败');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, isEdit, taskId, todayKey]);

  const patch = (next: Partial<TaskDraft>) => setDraft((current) => ({ ...current, ...next }));

  const save = async () => {
    const validation = validateTaskDraft(draft);
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (taskId === undefined) {
        await api.createTask(buildCreateTaskPayload(draft));
      } else {
        await api.updateTask(taskId, buildUpdateTaskPayload(draft));
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (taskId === undefined) {
      return;
    }
    Alert.alert('删除这条待办？', '删除后无法恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setSaving(true);
            setError(null);
            try {
              await api.deleteTask(taskId);
              onSaved();
            } catch (cause) {
              setError(cause instanceof ApiError ? cause.message : '删除失败');
            } finally {
              setSaving(false);
            }
          })();
        },
      },
    ]);
  };

  if (loading) {
    return (
      <Screen>
        <EditorHeader title="编辑待办" onCancel={onCancel} onSave={() => {}} saving />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.color.accent} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <EditorHeader
        title={isEdit ? '编辑待办' : '新建待办'}
        onCancel={onCancel}
        onSave={() => void save()}
        saving={saving}
      />

      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.md, paddingBottom: theme.spacing.xxl }}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          <FormInput
            value={draft.title}
            onChangeText={(title) => patch({ title })}
            placeholder="待办标题"
            accessibilityLabel="待办标题"
            fontSize={18}
            autoFocus={!isEdit}
          />
        </Card>

        <View style={{ marginTop: theme.spacing.md }}>
          <Card>
            <FormRow label="截止时间">
              <Switch
                value={draft.hasDue}
                onValueChange={(hasDue) => patch({ hasDue })}
                accessibilityLabel="设置截止时间"
                trackColor={{ false: theme.color.border, true: theme.color.accent }}
                thumbColor={theme.color.surfaceRaised}
              />
            </FormRow>

            {draft.hasDue ? (
              <>
                <FormRow label="日期">
                  <FormRowText
                    value={draft.dueDate}
                    placeholder="YYYY-MM-DD"
                    onChangeText={(dueDate) => patch({ dueDate })}
                  />
                </FormRow>
                <FormRow label="全天">
                  <Switch
                    value={draft.allDay}
                    onValueChange={(allDay) => patch({ allDay })}
                    accessibilityLabel="全天待办"
                    trackColor={{ false: theme.color.border, true: theme.color.accent }}
                    thumbColor={theme.color.surfaceRaised}
                  />
                </FormRow>
                {!draft.allDay ? (
                  <FormRow label="时间">
                    <FormRowText
                      value={draft.dueTime}
                      placeholder="09:00"
                      onChangeText={(dueTime) => patch({ dueTime })}
                    />
                  </FormRow>
                ) : null}
              </>
            ) : (
              <FormRow label="归属">
                <Text style={{ color: theme.color.textTertiary, fontSize: 13 }}>待安排</Text>
              </FormRow>
            )}

            <FormRow label="优先级" last>
              <View style={{ flex: 1, marginLeft: theme.spacing.sm }}>
                <SegmentedControl
                  label="优先级"
                  options={TASK_PRIORITY_OPTIONS}
                  value={draft.priority}
                  onChange={(priority) => patch({ priority })}
                />
              </View>
            </FormRow>
          </Card>
        </View>

        <View style={{ marginTop: theme.spacing.md }}>
          <Card>
            <FormTextArea
              value={draft.description}
              placeholder="添加备注…"
              onChangeText={(description) => patch({ description })}
            />
          </Card>
        </View>

        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.md }}>{error}</Text>
        ) : null}

        {isEdit ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="删除待办"
            onPress={remove}
            disabled={saving}
            style={[
              styles.delete,
              { borderColor: theme.color.border, borderRadius: theme.radius.button, marginTop: theme.spacing.lg },
            ]}
          >
            <Text style={{ color: theme.color.danger, fontSize: 15 }}>删除待办</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  delete: { borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingVertical: 14 },
});
