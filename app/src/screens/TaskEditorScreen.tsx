import { useEffect, useState } from 'react';
import { userFacingError } from '../domain/errors';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { Card, Screen } from '../components/ui';
import {
  EditorHeader,
  FormInput,
  FormRow,
  FormRowValue,
  FormTextArea,
  SegmentedControl,
} from '../components/form';
import { WheelDatePicker } from '../components/WheelDatePicker';
import { WheelLayer } from '../components/WheelLayer';
import { WheelTimePicker } from '../components/WheelTimePicker';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import type { PickedEvent } from './EventPickerScreen';
import { buildRrule, describeRecurrence, parseRrule, type Recurrence } from '../domain/recurrence';
import { describeReminders, normalizeReminders } from '../domain/reminderSchedule';
import { persistReminderSettings, refreshLocalReminders } from '../notifications/actions';
import type { RecurrenceSelection, ReminderSelection } from './editorSelection';
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
  eventSelection,
  recurrenceSelection,
  reminderSelection,
  onPickEvent,
  onPickRecurrence,
  onPickReminder,
  onCancel,
  onSaved,
}: {
  todayKey: string;
  /** 传了就是编辑已有待办 */
  taskId?: number;
  /** 从「选择日程」页回传的关联结果 */
  eventSelection: { version: number; event: PickedEvent | null };
  recurrenceSelection: RecurrenceSelection;
  reminderSelection: ReminderSelection;
  onPickEvent: () => void;
  /** 第二个参数是待办的截止日期，用来算「每周默认勾哪天」 */
  onPickRecurrence: (current: Recurrence, startDateKey: string) => void;
  onPickReminder: (current: number[]) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const theme = useAppTheme();
  const { api, reminders } = useRuntime();
  const { notificationEnabled } = useAppSessionState();
  const isEdit = typeof taskId === 'number';

  const [draft, setDraft] = useState<TaskDraft>(() => emptyTaskDraft(todayKey));
  /** 打开编辑页时服务端上的提醒设置（用于「没改过就不多发一次 PUT」） */
  const [initialReminders, setInitialReminders] = useState<number[]>([]);
  /** 正在用滚轮改哪一栏（null = 没开选择层） */
  const [wheelField, setWheelField] = useState<'dueDate' | 'dueTime' | null>(null);
  const [wheelDraft, setWheelDraft] = useState('');
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
        /**
         * 提醒不在 task 行上（spec §4.5 的分工）：`draftFromTask` 只能给空数组，
         * 真正的值要单独拉一次 `GET /reminders`。拉失败就当没设提醒，不打断编辑。
         */
        try {
          const loaded = await api.reminders('TASK', taskId);
          if (!cancelled) {
            const minutes = normalizeReminders(loaded.map((item) => item.minutesBefore));
            setInitialReminders(minutes);
            setDraft((current) => ({ ...current, reminders: minutes }));
          }
        } catch {
          // 提醒读不到就当没有
        }
      } catch (cause) {
        if (!cancelled) {
          setError(userFacingError(cause, '加载待办失败'));
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

  /** 改动草稿时顺手清掉上一次的错误提示（否则改对了红字还挂着，像没改对） */
  const patch = (next: Partial<TaskDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  };

  const openWheel = (field: 'dueDate' | 'dueTime') => {
    setWheelDraft(field === 'dueDate' ? draft.dueDate : draft.dueTime);
    setWheelField(field);
  };
  const confirmWheel = () => {
    if (wheelField === 'dueDate') {
      patch({ dueDate: wheelDraft });
    } else if (wheelField === 'dueTime') {
      patch({ dueTime: wheelDraft });
    }
    setWheelField(null);
  };

  // 从「选择日程」页返回时把结果并进草稿；依赖 version，因为连续两次选「不关联」时值都是 null
  useEffect(() => {
    if (eventSelection.version === 0) {
      return;
    }
    setDraft((current) => ({
      ...current,
      eventId: eventSelection.event?.eventId ?? null,
      eventTitle: eventSelection.event?.title ?? null,
    }));
  }, [eventSelection.version, eventSelection.event]);

  // 从「重复」页返回（同样只在按下「完成」时才生效）
  useEffect(() => {
    if (recurrenceSelection.version === 0 || !recurrenceSelection.recurrence) {
      return;
    }
    // 不重复要提交空串而不是 null：PATCH 里 null 是「不修改」
    const rrule = buildRrule(recurrenceSelection.recurrence) ?? '';
    setDraft((current) => ({ ...current, rrule }));
  }, [recurrenceSelection.version, recurrenceSelection.recurrence]);

  // 从「提醒」页返回
  useEffect(() => {
    if (reminderSelection.version === 0) {
      return;
    }
    setDraft((current) => ({ ...current, reminders: normalizeReminders(reminderSelection.minutes) }));
  }, [reminderSelection.version, reminderSelection.minutes]);

  const recurrence = parseRrule(draft.rrule, draft.dueDate);

  const save = async () => {
    const validation = validateTaskDraft(draft);
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let savedId: number;
      if (taskId === undefined) {
        const created = await api.createTask(buildCreateTaskPayload(draft));
        savedId = created.id;
      } else {
        await api.updateTask(taskId, buildUpdateTaskPayload(draft));
        savedId = taskId;
      }
      try {
        await persistReminderSettings({
          api,
          targetType: 'TASK',
          targetId: savedId,
          minutes: draft.reminders,
          initialMinutes: initialReminders,
        });
        setInitialReminders(normalizeReminders(draft.reminders));
      } catch (cause) {
        setError(
          `待办已保存，但提醒没有存上：${userFacingError(cause, '请稍后重试')}`,
        );
        return;
      }
      const local = await refreshLocalReminders({
        api,
        scheduler: reminders,
        enabled: notificationEnabled,
      });
      if (local.permissionDenied && draft.reminders.length > 0) {
        Alert.alert('提醒不会响', '系统还没允许本应用发送通知，请在系统设置里打开通知权限。');
      }
      onSaved();
    } catch (cause) {
      setError(userFacingError(cause, '保存失败'));
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
              // 本机那条排期要跟着消失：重排一次，服务端已经不再返回它
              await refreshLocalReminders({ api, scheduler: reminders, enabled: notificationEnabled });
              onSaved();
            } catch (cause) {
              setError(userFacingError(cause, '删除失败'));
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
                {/* 日期与时间都走滚轮：手机上手打 YYYY-MM-DD / HH:mm 又慢又容易错（spec §4.1.5） */}
                <FormRow label="日期" onPress={() => openWheel('dueDate')}>
                  <FormRowValue text={draft.dueDate} placeholder="选择日期" />
                </FormRow>
                {/* 没有「全天」开关：拨到 00:00 就是「就这一天」 */}
                <FormRow label="时间" onPress={() => openWheel('dueTime')}>
                  <FormRowValue text={draft.dueTime} placeholder="09:00" />
                </FormRow>
              </>
            ) : (
              // 这里原来放了一个叫「归属」的只读行，长得像表单字段却点不动，容易误解。
              // 「待安排」是截止时间开关推导出来的结果，用一句说明表达就够了。
              <View />
            )}

            {/* 关联日程：这是可点击的入口，选完在下方显示关联对象并支持解除 */}
            <FormRow label="关联日程" onPress={onPickEvent}>
              <Text
                style={{
                  color: draft.eventTitle ? theme.color.textPrimary : theme.color.textTertiary,
                  fontSize: 15,
                  flex: 1,
                  textAlign: 'right',
                }}
              >
                {draft.eventTitle ?? '选择日程'}
              </Text>
              <Text style={{ color: theme.color.textTertiary, fontSize: 16, marginLeft: 6 }}>›</Text>
            </FormRow>

            {/*
              重复与提醒只在「有截止时间」时出现：没有时间点的待办是「待安排」，
              「每周五」这种规则与「提前十分钟」都没有可依附的时刻。
              与其给两个点了没用（甚至会被服务端当成无效规则）的入口，不如不显示。
            */}
            {draft.hasDue ? (
              <>
                <FormRow
                  label="重复"
                  onPress={() => onPickRecurrence(parseRrule(draft.rrule, draft.dueDate), draft.dueDate)}
                >
                  <FormRowValue
                    text={recurrence.frequency === 'NONE' ? null : describeRecurrence(recurrence)}
                    placeholder="不重复"
                  />
                </FormRow>

                <FormRow
                  label="提醒"
                  onPress={() => onPickReminder(normalizeReminders(draft.reminders))}
                >
                  <FormRowValue
                    text={draft.reminders.length > 0 ? describeReminders(draft.reminders) : null}
                    placeholder="不提醒"
                  />
                </FormRow>
              </>
            ) : null}

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

        {!draft.hasDue ? (
          <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 6, marginLeft: 4 }}>
            未设截止时间的待办会归入「待安排」
          </Text>
        ) : null}

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

        {draft.eventId !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="解除日程关联"
            onPress={() => patch({ eventId: null, eventTitle: null })}
          >
            <Text style={{ color: theme.color.textTertiary, fontSize: 13, marginTop: theme.spacing.sm }}>
              解除日程关联
            </Text>
          </Pressable>
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

      {/* 日期 / 时间选择层（spec §7.6.7：日期时间选择用弹层） */}
      {wheelField ? (
        <WheelLayer
          title={wheelField === 'dueDate' ? '截止日期' : '截止时间'}
          onCancel={() => setWheelField(null)}
          onConfirm={confirmWheel}
        >
          {wheelField === 'dueDate' ? (
            <WheelDatePicker value={wheelDraft} onChange={setWheelDraft} />
          ) : (
            <WheelTimePicker value={wheelDraft} onChange={setWheelDraft} />
          )}
        </WheelLayer>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  delete: { borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingVertical: 14 },
});
