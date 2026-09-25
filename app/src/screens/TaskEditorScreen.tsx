import { useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';

import { ApiError } from '../api/client';
import { Card, Screen } from '../components/ui';
import { EditorHeader, FormInput, FormRow, FormRowText, FormTextArea, SegmentedControl } from '../components/form';
import { useAppTheme, useRuntime } from '../context/AppContext';
import {
  TASK_PRIORITY_OPTIONS,
  buildCreateTaskPayload,
  emptyTaskDraft,
  validateTaskDraft,
  type TaskDraft,
} from '../domain/taskDraft';

/**
 * 新建待办：**独立整页**，不是列表顶部的内联输入框（spec §4.1.5 / §7.6.7）。
 *
 * 待办比日程多一个特性——截止时间可以不存在（归入「待安排」），
 * 所以这里用显式开关表达，而不是让用户去猜空输入框是什么意思。
 */
export function TaskEditorScreen({
  todayKey,
  onCancel,
  onSaved,
}: {
  todayKey: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const theme = useAppTheme();
  const { api } = useRuntime();

  const [draft, setDraft] = useState<TaskDraft>(() => emptyTaskDraft(todayKey));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
      await api.createTask(buildCreateTaskPayload(draft));
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <EditorHeader title="新建待办" onCancel={onCancel} onSave={() => void save()} saving={saving} />

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
            autoFocus
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
      </ScrollView>
    </Screen>
  );
}
