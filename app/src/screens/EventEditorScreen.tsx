import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import type { EventDetail } from '../api/types';
import { ApiError } from '../api/client';
import { Card, Screen } from '../components/ui';
import {
  EditorHeader,
  FormInput,
  FormRow,
  FormRowText,
  FormTextArea,
  SegmentedControl,
} from '../components/form';
import { useAppTheme, useRuntime } from '../context/AppContext';
import {
  AVAILABILITY_OPTIONS,
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  addMinutes,
  buildCreatePayload,
  buildUpdatePayload,
  draftFromEvent,
  emptyDraft,
  eventDateKey,
  validateDraft,
  type EventDraft,
  type EventPlace,
} from '../domain/eventDraft';

/** 地点选择的回传：用 version 区分「重新选了同一个地点」与「选了不设地点」。 */
export interface PlaceSelection {
  version: number;
  place: EventPlace | null;
}

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
  onPickLocation,
  onCancel,
  onSaved,
}: {
  dateKey: string;
  /** 传了就是编辑已有日程 */
  eventId?: number;
  /** 重复日程里被点开的那一次，用于「仅此一次」的编辑/删除 */
  occurrenceDate?: string | null;
  placeSelection: PlaceSelection;
  onPickLocation: () => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const theme = useAppTheme();
  const { api } = useRuntime();
  const isEdit = typeof eventId === 'number';

  const [draft, setDraft] = useState<EventDraft>(emptyDraft);
  const [dateKey, setDateKey] = useState(initialDateKey);
  const [detail, setDetail] = useState<EventDetail | null>(null);
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

  const patch = (next: Partial<EventDraft>) => setDraft((current) => ({ ...current, ...next }));

  const isRecurring = Boolean(detail?.rrule);

  const persist = async (scope: 'THIS' | 'ALL') => {
    setSaving(true);
    setError(null);
    try {
      if (eventId === undefined) {
        await api.createEvent(buildCreatePayload(dateKey, draft));
      } else {
        await api.updateEvent(eventId, {
          ...buildUpdatePayload(dateKey, draft),
          scope,
          occurrenceDate: scope === 'THIS' ? occurrenceDate ?? null : null,
        });
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
                <FormRow label="开始">
                  <FormRowText
                    value={draft.startTime}
                    placeholder="09:00"
                    onChangeText={(startTime) =>
                      // 结束时间跟随开始 +1 小时，减少一次手动输入
                      patch({ startTime, endTime: addMinutes(startTime, 60) })
                    }
                  />
                </FormRow>
                <FormRow label="结束">
                  <FormRowText
                    value={draft.endTime}
                    placeholder="10:00"
                    onChangeText={(endTime) => patch({ endTime })}
                  />
                </FormRow>
              </>
            ) : null}

            <FormRow label="地点" onPress={onPickLocation} last>
              <Text
                style={{
                  color: draft.place ? theme.color.textPrimary : theme.color.textTertiary,
                  fontSize: 15,
                  flex: 1,
                  textAlign: 'right',
                }}
              >
                {draft.place ? draft.place.name : '添加地点'}
              </Text>
              <Text style={{ color: theme.color.textTertiary, fontSize: 16, marginLeft: 6 }}>›</Text>
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  delete: { borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingVertical: 14 },
});
