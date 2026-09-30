import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card, Screen } from '../components/ui';
import { CheckRow, EditorHeader, FormInput } from '../components/form';
import { useAppTheme } from '../context/AppContext';
import { localNotificationsAvailable } from '../notifications/availability';
import {
  REMINDER_PRESETS,
  describeReminders,
  formatMinutesBefore,
  normalizeReminders,
  parseCustomMinutes,
  toggleReminder,
} from '../domain/reminderSchedule';

/**
 * 提醒（spec §4.1.2 / §4.1.4 / §4.5）。
 *
 * 可多选：服务端 `reminder` 表本身就是「一个目标多条记录」，界面上却常常只给一个值 ——
 * 「提前一天 + 提前十分钟」是很常见的一组，做成单选等于让用户丢一条。
 *
 * 这一页只产出分钟数组；真正的排期（`expo-notifications`）与提交（`PUT /reminders`）
 * 分别在 `domain/reminderSchedule.ts` 与日程编辑页里，页面不碰原生 API。
 */
export function ReminderPickerScreen({
  initial,
  onCancel,
  onConfirm,
}: {
  initial: number[];
  onCancel: () => void;
  onConfirm: (minutes: number[]) => void;
}) {
  const theme = useAppTheme();
  const [selected, setSelected] = useState<number[]>(normalizeReminders(initial));
  const [customText, setCustomText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const presetValues = REMINDER_PRESETS as readonly number[];
  /** 非预置的提前量单独列出来，否则用户自定义过一次就再也看不到、也删不掉它 */
  const customSelected = selected.filter((minutes) => !presetValues.includes(minutes));

  const addCustom = () => {
    const parsed = parseCustomMinutes(customText);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setSelected((current) => toggleReminder(current, parsed.minutes));
    setCustomText('');
    setError(null);
  };

  return (
    <Screen>
      <EditorHeader
        title="提醒"
        saveLabel="完成"
        onCancel={onCancel}
        onSave={() => onConfirm(selected)}
      />

      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.md, paddingBottom: theme.spacing.xxl }}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          {REMINDER_PRESETS.map((minutes, index) => (
            <CheckRow
              key={minutes}
              label={formatMinutesBefore(minutes)}
              selected={selected.includes(minutes)}
              role="checkbox"
              onPress={() => {
                setSelected((current) => toggleReminder(current, minutes));
                setError(null);
              }}
              last={index === REMINDER_PRESETS.length - 1}
            />
          ))}
        </Card>

        {customSelected.length > 0 ? (
          <View style={{ marginTop: theme.spacing.md }}>
            <Card>
              {customSelected.map((minutes, index) => (
                <CheckRow
                  key={minutes}
                  label={formatMinutesBefore(minutes)}
                  selected
                  role="checkbox"
                  onPress={() => setSelected((current) => toggleReminder(current, minutes))}
                  last={index === customSelected.length - 1}
                />
              ))}
            </Card>
          </View>
        ) : null}

        <View style={{ marginTop: theme.spacing.md }}>
          <Card>
            <View style={styles.customRow}>
              <Text style={{ color: theme.color.textSecondary, fontSize: 15 }}>自定义</Text>
              <View style={{ flex: 1, marginLeft: theme.spacing.sm }}>
                <FormInput
                  value={customText}
                  placeholder="提前多少分钟"
                  accessibilityLabel="自定义提醒分钟数"
                  keyboardType="number-pad"
                  onChangeText={(value) => {
                    setCustomText(value);
                    setError(null);
                  }}
                />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="添加自定义提醒"
                onPress={addCustom}
                hitSlop={8}
              >
                <Text style={{ color: theme.color.accent, fontSize: 15 }}>添加</Text>
              </Pressable>
            </View>
          </Card>
        </View>

        <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: theme.spacing.md }}>
          当前：{describeReminders(selected)}
        </Text>
        {/* 说清楚提醒由谁发：用户会以为「没提醒是没网」，实际是本地通知（spec §4.5） */}
        <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 4 }}>
        {localNotificationsAvailable()
          ? '提醒由手机本地发出，不需要联网；日程改动或删除后会自动重排。'
            // 运行环境（Expo Go / 开发构建）是开发者的概念，用户只需要知道「这台设备响不响」
            : '这台设备暂时不能到点响铃，设置仍会保存到账号。'}
        </Text>

        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.md }}>{error}</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  customRow: { flexDirection: 'row', alignItems: 'center' },
});
