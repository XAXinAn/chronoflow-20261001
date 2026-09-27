import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import type { EventDetail } from '../api/types';
import { ApiError } from '../api/client';
import { Card, Screen } from '../components/ui';
import { WheelLayer } from '../components/WheelLayer';
import { WheelTimePicker } from '../components/WheelTimePicker';
import {
  EditorHeader,
  FormInput,
  FormRow,
  FormRowValue,
  FormRowText,
  FormTextArea,
  SegmentedControl,
} from '../components/form';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import {
  AVAILABILITY_OPTIONS,
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  addMinutes,
  buildCreatePayload,
  buildUpdatePayload,
  DEFAULT_START_TIME,
  draftFromEvent,
  emptyDraft,
  eventDateKey,
  validateDraft,
  type EventDraft,
} from '../domain/eventDraft';
import { buildRrule, describeRecurrence, parseRrule, type Recurrence } from '../domain/recurrence';
import { describeReminders, normalizeReminders } from '../domain/reminderSchedule';
import { persistReminderSettings, refreshLocalReminders } from '../notifications/actions';
import type {
  PlaceSelection,
  RecurrenceSelection,
  ReminderSelection,
} from './editorSelection';

/**
 * 二级页回传（地点 / 重复 / 提醒）由 `editorSelection.ts` 统一定义：
 * 日程与待办两个编辑页共用同一套「version 变了才算改过」的语义。
 */
export type {
  PlaceSelection,
  RecurrenceSelection,
  ReminderSelection,
} from './editorSelection';

/**
 * 新建 / 编辑日程：**独立整页**，不是弹窗（spec §4.1.5 / §7.6.7）。
 *
 * 新建与编辑共用同一个页面：字段完全一致，分成两个页面只会让两边逐渐长歪。
 * 差别只在标题、保存走 POST 还是 PATCH、以及编辑态多一个删除入口。
 *
 * 日期不在这里选——新建时取「在日历上选中的那天」，编辑时取日程自己的日期，
 * 少一个控件少一次误操作。
 */
export function EventEditorScreen({
  dateKey: initialDateKey,
  eventId,
  occurrenceDate,
  placeSelection,
  recurrenceSelection,
  reminderSelection,
  onPickLocation,
  onPickRecurrence,
  onPickReminder,
  onCancel,
  onSaved,
}: {
  dateKey: string;
  /** 传了就是编辑已有日程 */
  eventId?: number;
  /** 重复日程里被点开的那一次，用于「仅此一次」的编辑/删除 */
  occurrenceDate?: string | null;
  placeSelection: PlaceSelection;
  recurrenceSelection: RecurrenceSelection;
  reminderSelection: ReminderSelection;
  onPickLocation: () => void;
  /** 第二个参数是日程自己的日期（编辑时可能与列表页选中的那天不同） */
  onPickRecurrence: (current: Recurrence, startDateKey: string) => void;
  onPickReminder: (current: number[]) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const theme = useAppTheme();
  const { api, reminders } = useRuntime();
  const { notificationEnabled } = useAppSessionState();
  const isEdit = typeof eventId === 'number';

  const [draft, setDraft] = useState<EventDraft>(emptyDraft);
  const [dateKey, setDateKey] = useState(initialDateKey);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  /**
   * 打开编辑页时服务端上的提醒设置。
   *
   * 存一份是为了「没改过就不多发一次 PUT」：`PUT /reminders` 是整体覆盖，
   * 每次保存都发一遍虽然结果一样，但会给服务端多一次无谓的删除 + 插入。
   */
  const [initialReminders, setInitialReminders] = useState<number[]>([]);
  /** 正在用滚轮改哪个时间（null = 没开选择层）；`draft` 是滚轮里的临时值 */
  const [timeField, setTimeField] = useState<'start' | 'end' | null>(null);
  const [timeDraft, setTimeDraft] = useState(DEFAULT_START_TIME);
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 编辑态先把已有内容拉回来预填
  useEffect(() => {
    if (!isEdit || eventId === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await api.eventDetail(eventId);
        if (cancelled) {
          return;
        }
        setDetail(loaded);
        setDraft(draftFromEvent(loaded));
        // 日程自己的日期，而不是列表页选中的那天——编辑时两者可能不同
        setDateKey(eventDateKey(loaded));
        /**
         * 提醒不在 event 行上（spec §4.5 的分工）：`draftFromEvent` 只能给空数组，
         * 真正的值要单独拉一次 `GET /reminders`。
         *
         * 拉失败不能让整页打不开 —— 日程本身已经拿到了，提醒显示成「不提醒」，
         * 用户改完保存时看到的也是这一份，不会莫名覆盖掉服务端的数据。
         */
        try {
          const reminders = await api.reminders('EVENT', eventId);
          if (cancelled) {
            return;
          }
          const minutes = normalizeReminders(reminders.map((item) => item.minutesBefore));
          setInitialReminders(minutes);
          setDraft((current) => ({ ...current, reminders: minutes }));
        } catch {
          // 提醒读不到就当没有，不打断编辑
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof ApiError ? cause.message : '加载日程失败');
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
  }, [api, eventId, isEdit]);

  // 从地点选择页返回时把结果并进草稿。依赖 version 而不是 place：
  // 连续两次选「不设地点」时 place 都是 null，只比值无法触发同步。
  useEffect(() => {
    if (placeSelection.version === 0) {
      return;
    }
    setDraft((current) => ({ ...current, place: placeSelection.place }));
  }, [placeSelection.version, placeSelection.place]);

  // 从重复规则页返回：只有「按了完成」才会带上 recurrence（version +1）
  useEffect(() => {
    if (recurrenceSelection.version === 0 || !recurrenceSelection.recurrence) {
      return;
    }
    // 不重复要提交空串而不是 null：PATCH 里 null 是「不修改」（spec §4.1.4）
    const rrule = buildRrule(recurrenceSelection.recurrence) ?? '';
    setDraft((current) => ({ ...current, rrule }));
  }, [recurrenceSelection.version, recurrenceSelection.recurrence]);

  // 从提醒页返回（同样只在按下「完成」时才生效）
  useEffect(() => {
    if (reminderSelection.version === 0) {
      return;
    }
    setDraft((current) => ({ ...current, reminders: normalizeReminders(reminderSelection.minutes) }));
  }, [reminderSelection.version, reminderSelection.minutes]);

  /**
   * 改动草稿时顺手清掉上一次的错误提示。
   *
   * 原先只在「保存」里 setError(null)：用户在模拟器上把时间改对了，
   * 红字「时间格式应为 HH:mm」还挂在屏幕上，看起来像仍然没改对。
   */
  const patch = (next: Partial<EventDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  };
  const openTimePicker = (field: 'start' | 'end') => {
    setTimeDraft(field === 'start' ? draft.startTime : draft.endTime);
    setTimeField(field);
  };
  const confirmTimePicker = () => {
    if (timeField === 'start') {
      // 结束时间跟随开始 +1 小时，少一次拨动（与手输时代的行为一致）
      patch({ startTime: timeDraft, endTime: addMinutes(timeDraft, 60) });
    } else if (timeField === 'end') {
      patch({ endTime: timeDraft });
    }
    setTimeField(null);
  };

  const isRecurring = Boolean(detail?.rrule);

  /** 编辑页「重复」行：由 RRULE 解析回来（解析不出的串按「不重复」显示，见 domain/recurrence） */
  const recurrence = parseRrule(draft.rrule, dateKey);
  const recurrenceSummary = describeRecurrence(recurrence);

  const persist = async (scope: 'THIS' | 'ALL') => {
    setSaving(true);
    setError(null);
    try {
      let savedId: number;
      const timeRange = buildCreatePayload(dateKey, draft);
      if (eventId === undefined) {
        const created = await api.createEvent(timeRange);
        savedId = created.id;
      } else {
        await api.updateEvent(eventId, {
          ...buildUpdatePayload(dateKey, draft),
          scope,
          occurrenceDate: scope === 'THIS' ? occurrenceDate ?? null : null,
        });
        savedId = eventId;
      }
      /**
       * 提醒是整体覆盖（`PUT /reminders`）。只在真的改过时才发：
       * 没改也发一遍虽然结果一样，但会让「保存」这个动作多一次没必要的写。
       */
      try {
        await persistReminderSettings({
          api,
          targetType: 'EVENT',
          targetId: savedId,
          minutes: draft.reminders,
          initialMinutes: initialReminders,
        });
        setInitialReminders(normalizeReminders(draft.reminders));
      } catch (cause) {
        // 日程已经存下了。这里**不能**当作「保存失败」整条回滚口吻提示，
        // 也不能直接返回列表（用户看不到问题、更没法重试）
        setError(
          `日程已保存，但提醒没有存上：${cause instanceof ApiError ? cause.message : '请稍后重试'}`,
        );
        return;
      }
      /**
       * 本机排期跟着走。
       *
       * 不做「本地推算这次改了什么」：重复日程的展开在服务端，删除 / 跨设备改动
       * 也在服务端，本地推算总有漏掉的路径。统一拉一次未来排期再对齐。
       */
      const local = await refreshLocalReminders({
        api,
        scheduler: reminders,
        enabled: notificationEnabled,
      });
      if (local.permissionDenied && draft.reminders.length > 0) {
        // 设置存下了、但通知响不了，必须说清楚，否则用户会以为「提醒坏了」
        Alert.alert('提醒不会响', '系统还没允许本应用发送通知，请在系统设置里打开通知权限。');
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const validation = validateDraft(draft);
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    // 重复日程要问清楚改哪一段：改错范围会连带改掉用户没打算动的那些天
    if (isEdit && isRecurring) {
      Alert.alert('这条日程是重复日程', '本次修改应用到哪一段？', [
        { text: '取消', style: 'cancel' },
        { text: '仅此一次', onPress: () => void persist('THIS') },
        { text: '整个系列', onPress: () => void persist('ALL') },
      ]);
      return;
    }
    await persist('ALL');
  };

  const remove = () => {
    if (eventId === undefined) {
      return;
    }
    const run = async (scope: 'THIS' | 'ALL') => {
      setSaving(true);
      setError(null);
      try {
        await api.deleteEvent(eventId, scope, scope === 'THIS' ? occurrenceDate ?? undefined : undefined);
        /**
         * 删除的日程不能留着提醒在系统里响（用户会以为是幽灵通知）：
         * 重排一次即可 —— 服务端已经不再返回它，对齐时本机那条会被取消。
         */
        await refreshLocalReminders({ api, scheduler: reminders, enabled: notificationEnabled });
        onSaved();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : '删除失败');
      } finally {
        setSaving(false);
      }
    };

    if (isRecurring) {
      Alert.alert('删除重复日程', '要删除哪一段？', [
        { text: '取消', style: 'cancel' },
        { text: '仅此一次', onPress: () => void run('THIS') },
        { text: '整个系列', style: 'destructive', onPress: () => void run('ALL') },
      ]);
      return;
    }
    Alert.alert('删除这条日程？', '删除后无法恢复。', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => void run('ALL') },
    ]);
  };

  if (loading) {
    return (
      <Screen>
        <EditorHeader title="编辑日程" onCancel={onCancel} onSave={() => {}} saving />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.color.accent} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <EditorHeader
        title={isEdit ? '编辑日程' : '新建日程'}
        // 取消就是取消：不再弹「放弃未保存的修改？」——用户已经明确表达要退出了
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
            placeholder="日程标题"
            accessibilityLabel="日程标题"
            fontSize={18}
            autoFocus={!isEdit}
          />
        </Card>

        <View style={{ marginTop: theme.spacing.md }}>
          <Card>
            <FormRow label="日期">
              <Text style={{ color: theme.color.textPrimary, fontSize: 15 }}>{dateKey}</Text>
            </FormRow>

            <FormRow label="全天">
              <Switch
                value={draft.allDay}
                onValueChange={(allDay) => patch({ allDay })}
                accessibilityLabel="全天"
                trackColor={{ false: theme.color.border, true: theme.color.accent }}
                thumbColor={theme.color.surfaceRaised}
              />
            </FormRow>

            {!draft.allDay ? (
              <>
                {/* 时间用滚轮选：手打 HH:mm 在手机上又慢又容易错（spec §4.1.5） */}
                <FormRow label="开始" onPress={() => openTimePicker('start')}>
                  <FormRowValue text={draft.startTime} placeholder="09:00" />
                </FormRow>
                <FormRow label="结束" onPress={() => openTimePicker('end')}>
                  <FormRowValue text={draft.endTime} placeholder="10:00" />
                </FormRow>
              </>
            ) : null}

            {/* 重复与提醒各进一个二级页面：字段多、还要返回栈（spec §4.1.5） */}
            <FormRow
              label="重复"
              onPress={() => onPickRecurrence(recurrence, dateKey)}
            >
              <FormRowValue
                text={recurrence.frequency === 'NONE' ? null : recurrenceSummary}
                placeholder="不重复"
              />
            </FormRow>

            <FormRow label="提醒" onPress={() => onPickReminder(normalizeReminders(draft.reminders))}>
              <FormRowValue
                text={draft.reminders.length > 0 ? describeReminders(draft.reminders) : null}
                placeholder="不提醒"
              />
            </FormRow>

            <FormRow label="地点" onPress={onPickLocation}>
              <FormRowValue text={draft.place?.name ?? null} placeholder="添加地点" />
            </FormRow>
            {/* 地图常常只定位到楼，教室/门牌由用户手填（与地点都可空，spec §5.9） */}
            <FormRow label="详细地址" last>
              <FormRowText
                value={draft.locationDetail}
                placeholder="3 号楼 305（选填）"
                onChangeText={(locationDetail) => patch({ locationDetail })}
              />
            </FormRow>
          </Card>
        </View>

        {draft.place?.address ? (
          <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 6, marginLeft: 4 }}>
            {draft.place.address}
          </Text>
        ) : null}

        <View style={{ marginTop: theme.spacing.md }}>
          <Card>
            <FormTextArea
              value={draft.description}
              placeholder="添加备注、议程…"
              onChangeText={(description) => patch({ description })}
            />
          </Card>
        </View>

        <View style={{ marginTop: theme.spacing.md }}>
          <Card>
            <FormRow label="链接">
              <FormRowText
                value={draft.url}
                placeholder="http:// 或 https://"
                onChangeText={(url) => patch({ url })}
              />
            </FormRow>
            <FormRow label="分类">
              <FormRowText
                value={draft.category}
                placeholder="如：会议"
                onChangeText={(category) => patch({ category })}
              />
            </FormRow>
            <FormRow label="出行">
              <FormRowText
                value={draft.travelTimeMinutes}
                placeholder="分钟"
                onChangeText={(travelTimeMinutes) => patch({ travelTimeMinutes })}
              />
            </FormRow>
            <FormRow label="优先级">
              <View style={{ flex: 1, marginLeft: theme.spacing.sm }}>
                <SegmentedControl
                  label="优先级"
                  options={PRIORITY_OPTIONS}
                  value={draft.priority}
                  onChange={(priority) => patch({ priority })}
                />
              </View>
            </FormRow>
            <FormRow label="闲忙">
              <View style={{ flex: 1, marginLeft: theme.spacing.sm }}>
                <SegmentedControl
                  label="闲忙"
                  options={AVAILABILITY_OPTIONS}
                  value={draft.availability}
                  onChange={(availability) => patch({ availability })}
                />
              </View>
            </FormRow>
            <FormRow label="状态" last>
              <View style={{ flex: 1, marginLeft: theme.spacing.sm }}>
                <SegmentedControl
                  label="状态"
                  options={STATUS_OPTIONS}
                  value={draft.status}
                  onChange={(status) => patch({ status })}
                />
              </View>
            </FormRow>
          </Card>
        </View>

        {draft.place ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="清除地点"
            onPress={() => patch({ place: null })}
          >
            <Text style={{ color: theme.color.textTertiary, fontSize: 13, marginTop: theme.spacing.md }}>
              清除地点
            </Text>
          </Pressable>
        ) : null}

        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.md }}>{error}</Text>
        ) : null}

        {isEdit ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="删除日程"
            onPress={remove}
            disabled={saving}
            style={[
              styles.delete,
              { borderColor: theme.color.border, borderRadius: theme.radius.button, marginTop: theme.spacing.lg },
            ]}
          >
            <Text style={{ color: theme.color.danger, fontSize: 15 }}>删除日程</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {/* 时间选择层：贴在底部，不遮全屏，拨滚轮时还能看到上面的表单（spec §7.6.7） */}
      {timeField ? (
        <WheelLayer
          title={timeField === 'start' ? '开始时间' : '结束时间'}
          onCancel={() => setTimeField(null)}
          onConfirm={confirmTimePicker}
        >
          <WheelTimePicker value={timeDraft} onChange={setTimeDraft} />
        </WheelLayer>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  delete: { borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingVertical: 14 },
});
