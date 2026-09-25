import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { useAppTheme } from '../context/AppContext';
import {
  addMinutes,
  emptyDraft,
  validateDraft,
  type EventDraft,
} from '../domain/eventDraft';
import { PrimaryButton } from './ui';

interface EventEditorModalProps {
  visible: boolean;
  /** 新日程落在哪一天 */
  dateKey: string;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (draft: EventDraft) => void;
}

/**
 * 新建日程弹窗。
 *
 * 刻意不做日期选择器——日期由「你在日历上选中的那天」决定，
 * 少一个控件就少一次误操作；需要改日期就在日历上换个日子再点 +。
 */
export function EventEditorModal({
  visible,
  dateKey,
  saving,
  error,
  onCancel,
  onSubmit,
}: EventEditorModalProps) {
  const theme = useAppTheme();
  const [draft, setDraft] = useState<EventDraft>(emptyDraft);
  const [localError, setLocalError] = useState<string | null>(null);

  // 每次打开都重置，避免上一次的残留内容
  useEffect(() => {
    if (visible) {
      setDraft(emptyDraft());
      setLocalError(null);
    }
  }, [visible]);

  const submit = () => {
    const validation = validateDraft(draft);
    if (!validation.ok) {
      setLocalError(validation.message);
      return;
    }
    setLocalError(null);
    onSubmit(draft);
  };

  const inputStyle = [
    styles.input,
    {
      color: theme.color.textPrimary,
      borderColor: theme.color.border,
      borderRadius: theme.radius.input,
      backgroundColor: theme.color.surface,
    },
  ];

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.card },
          ]}
        >
          <Text style={[styles.title, { color: theme.color.textPrimary }]}>新建日程</Text>
          <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginBottom: theme.spacing.md }}>
            {dateKey}
          </Text>

          <TextInput
            value={draft.title}
            onChangeText={(title) => setDraft((current) => ({ ...current, title }))}
            placeholder="日程标题"
            accessibilityLabel="日程标题"
            placeholderTextColor={theme.color.textTertiary}
            autoFocus
            style={inputStyle}
          />

          <View style={[styles.switchRow, { marginTop: theme.spacing.md }]}>
            <Text style={{ color: theme.color.textPrimary }}>全天</Text>
            <Switch
              value={draft.allDay}
              accessibilityLabel="全天"
              onValueChange={(allDay) => setDraft((current) => ({ ...current, allDay }))}
              trackColor={{ false: theme.color.border, true: theme.color.accent }}
              thumbColor={theme.color.surfaceRaised}
            />
          </View>

          {!draft.allDay ? (
            <View style={[styles.timeRow, { marginTop: theme.spacing.sm }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.label, { color: theme.color.textSecondary }]}>开始</Text>
                <TextInput
                  value={draft.startTime}
                  onChangeText={(startTime) =>
                    setDraft((current) => ({
                      ...current,
                      startTime,
                      // 结束时间跟随开始时间 +1 小时，减少一次手动输入
                      endTime: addMinutes(startTime, 60),
                    }))
                  }
                  placeholder="09:00"
                  accessibilityLabel="开始时间"
                  keyboardType="numbers-and-punctuation"
                  placeholderTextColor={theme.color.textTertiary}
                  style={inputStyle}
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.label, { color: theme.color.textSecondary }]}>结束</Text>
                <TextInput
                  value={draft.endTime}
                  onChangeText={(endTime) => setDraft((current) => ({ ...current, endTime }))}
                  placeholder="10:00"
                  accessibilityLabel="结束时间"
                  keyboardType="numbers-and-punctuation"
                  placeholderTextColor={theme.color.textTertiary}
                  style={inputStyle}
                />
              </View>
            </View>
          ) : null}

          {localError || error ? (
            <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.sm }}>
              {localError ?? error}
            </Text>
          ) : null}

          <View style={[styles.actions, { marginTop: theme.spacing.lg }]}>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [
                styles.cancel,
                { borderColor: theme.color.border, borderRadius: theme.radius.button, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Text style={{ color: theme.color.textPrimary }}>取消</Text>
            </Pressable>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <PrimaryButton title="保存" onPress={submit} loading={saving} />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: { width: '100%', maxWidth: 420, padding: 20 },
  title: { fontSize: 20, fontWeight: '600', letterSpacing: -0.2 },
  label: { fontSize: 13, marginBottom: 6 },
  input: { height: 48, borderWidth: 1, paddingHorizontal: 12, fontSize: 16 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  timeRow: { flexDirection: 'row' },
  actions: { flexDirection: 'row', alignItems: 'center' },
  cancel: { height: 48, paddingHorizontal: 20, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
