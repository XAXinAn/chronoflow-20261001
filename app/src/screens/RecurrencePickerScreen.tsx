import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card, Screen } from '../components/ui';
import { CheckRow, EditorHeader, FormInput, FormRow } from '../components/form';
import { useAppTheme } from '../context/AppContext';
import { isValidDateKey } from '../domain/calendar';
import {
  END_OPTIONS,
  FREQUENCY_OPTIONS,
  MAX_COUNT,
  WEEKDAY_OPTIONS,
  toggleWeekday,
  weekdayOf,
  type EndKind,
  type Frequency,
  type Recurrence,
  type Weekday,
} from '../domain/recurrence';

/**
 * 重复规则（spec §4.1.2 / §4.1.4）。
 *
 * 独立二级页面而不是编辑页里的段控件：五种频率 + 星期多选 + 三种结束条件
 * 塞进一行会挤到点不准（spec §4.1.5 明确要求这类字段各带自己的返回栈）。
 *
 * 这一页只产出结构化的 `Recurrence`，RRULE 字符串的生成与解析留在
 * `domain/recurrence.ts`（那里有往返一致的单测盯着）。
 */
export function RecurrencePickerScreen({
  startDateKey,
  initial,
  onCancel,
  onConfirm,
}: {
  /** 日程的开始日期：用来算「每周默认勾哪天」，也用来校验「结束日期不能早于开始」 */
  startDateKey: string;
  initial: Recurrence;
  onCancel: () => void;
  onConfirm: (recurrence: Recurrence) => void;
}) {
  const theme = useAppTheme();
  const [frequency, setFrequency] = useState<Frequency>(initial.frequency);
  const [byWeekday, setByWeekday] = useState<Weekday[]>(initial.byWeekday);
  const [endKind, setEndKind] = useState<EndKind>(initial.endKind);
  const [untilDateKey, setUntilDateKey] = useState(initial.untilDateKey ?? startDateKey);
  const [countText, setCountText] = useState(String(initial.count));
  const [error, setError] = useState<string | null>(null);

  /** 切频率时补齐默认值：每周至少勾开始那天，否则用户会拿到一条「一周都不重复」的规则 */
  const changeFrequency = (next: Frequency) => {
    setFrequency(next);
    setError(null);
    if (next === 'WEEKLY' && byWeekday.length === 0) {
      setByWeekday([weekdayOf(startDateKey)]);
    }
  };

  const countValue = /^\d+$/.test(countText.trim()) ? Number(countText.trim()) : null;

  /** 保存前的校验：只拦「服务端认不出」或「语义为空」的组合，其余交给用户 */
  const validate = (): { ok: true; recurrence: Recurrence } | { ok: false; message: string } => {
    if (frequency === 'NONE') {
      return {
        ok: true,
        recurrence: { frequency: 'NONE', byWeekday: [], endKind: 'NEVER', untilDateKey: null, count: initial.count },
      };
    }
    if (frequency === 'WEEKLY' && byWeekday.length === 0) {
      return { ok: false, message: '每周至少选一天' };
    }
    let resolvedEndKind: EndKind = endKind;
    let resolvedUntil: string | null = null;
    let resolvedCount = initial.count;
    if (endKind === 'UNTIL') {
      const trimmed = untilDateKey.trim();
      if (!isValidDateKey(trimmed)) {
        return { ok: false, message: '结束日期格式应为 YYYY-MM-DD' };
      }
      // 早于开始日的「直到」规则在服务端会展开成 0 次，等于什么都没设
      if (trimmed < startDateKey) {
        return { ok: false, message: '结束日期不能早于日程开始日期' };
      }
      resolvedUntil = trimmed;
    } else if (endKind === 'COUNT') {
      if (countValue === null || countValue < 1 || countValue > MAX_COUNT) {
        return { ok: false, message: `次数需为 1-${MAX_COUNT} 之间的整数` };
      }
      resolvedCount = countValue;
    } else {
      resolvedEndKind = 'NEVER';
    }
    return {
      ok: true,
      recurrence: {
        frequency,
        byWeekday: frequency === 'WEEKLY' ? byWeekday : [],
        endKind: resolvedEndKind,
        untilDateKey: resolvedUntil,
        count: resolvedCount,
      },
    };
  };

  const submit = () => {
    const result = validate();
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onConfirm(result.recurrence);
  };

  return (
    <Screen>
      <EditorHeader
        title="重复"
        saveLabel="完成"
        onCancel={onCancel}
        onSave={submit}
      />

      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.md, paddingBottom: theme.spacing.xxl }}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          {FREQUENCY_OPTIONS.map((option, index) => (
            <CheckRow
              key={option.value}
              label={option.label}
              selected={frequency === option.value}
              role="radio"
              onPress={() => changeFrequency(option.value)}
              last={index === FREQUENCY_OPTIONS.length - 1}
            />
          ))}
        </Card>

        {frequency === 'WEEKLY' ? (
          <View style={{ marginTop: theme.spacing.md }}>
            <Card>
              <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginBottom: theme.spacing.sm }}>
                重复于（可多选）
              </Text>
              <View style={styles.chipWrap}>
                {WEEKDAY_OPTIONS.map((option) => {
                  const selected = byWeekday.includes(option.value);
                  return (
                    <Pressable
                      key={option.value}
                      accessibilityRole="checkbox"
                      accessibilityLabel={option.label}
                      accessibilityState={{ checked: selected }}
                      onPress={() => {
                        setByWeekday((current) => toggleWeekday(current, option.value));
                        setError(null);
                      }}
                      style={[
                        styles.chip,
                        {
                          borderColor: selected ? theme.color.accent : theme.color.border,
                          backgroundColor: selected ? theme.color.accent : 'transparent',
                          borderRadius: theme.radius.tag,
                        },
                      ]}
                    >
                      <Text
                        style={{
                          color: selected ? theme.color.accentContrast : theme.color.textSecondary,
                          fontSize: 13,
                          fontWeight: selected ? '600' : '400',
                        }}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </Card>
          </View>
        ) : null}

        {/* 「不重复」时结束条件没有意义，藏起来而不是给一堆点了没反应的控件 */}
        {frequency !== 'NONE' ? (
          <View style={{ marginTop: theme.spacing.md }}>
            <Card>
              {END_OPTIONS.map((option, index) => (
                <CheckRow
                  key={option.value}
                  label={option.label}
                  selected={endKind === option.value}
                  role="radio"
                  onPress={() => {
                    setEndKind(option.value);
                    setError(null);
                  }}
                  last={index === END_OPTIONS.length - 1}
                />
              ))}
            </Card>

            {endKind === 'UNTIL' ? (
              <View style={{ marginTop: theme.spacing.sm }}>
                <Card>
                  <FormRow label="结束日期" last>
                    <FormInput
                      value={untilDateKey}
                      placeholder="YYYY-MM-DD"
                      accessibilityLabel="结束日期"
                      onChangeText={(value) => {
                        setUntilDateKey(value);
                        setError(null);
                      }}
                    />
                  </FormRow>
                </Card>
              </View>
            ) : null}

            {endKind === 'COUNT' ? (
              <View style={{ marginTop: theme.spacing.sm }}>
                <Card>
                  <FormRow label="次数" last>
                    <FormInput
                      value={countText}
                      placeholder="10"
                      accessibilityLabel="重复次数"
                      keyboardType="number-pad"
                      onChangeText={(value) => {
                        setCountText(value);
                        setError(null);
                      }}
                    />
                  </FormRow>
                </Card>
              </View>
            ) : null}
          </View>
        ) : null}

        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.md }}>{error}</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 7 },
});
