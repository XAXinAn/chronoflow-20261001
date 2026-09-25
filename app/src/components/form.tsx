import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '../context/AppContext';

/**
 * 编辑页的三段式导航栏：取消 / 标题 / 保存（spec §7.6.7）。
 *
 * 不用系统导航栏是因为「保存」需要变成禁用态与保存中态，
 * 自绘才能同时满足黑白极简的视觉规范与交互状态。
 */
export function EditorHeader({
  title,
  onCancel,
  onSave,
  saving = false,
  saveDisabled = false,
}: {
  title: string;
  onCancel: () => void;
  onSave: () => void;
  saving?: boolean;
  saveDisabled?: boolean;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const dimmed = saving || saveDisabled;

  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top + theme.spacing.sm,
          backgroundColor: theme.color.surfaceRaised,
          borderBottomColor: theme.color.border,
        },
      ]}
    >
      <Pressable accessibilityRole="button" accessibilityLabel="取消" onPress={onCancel} hitSlop={10}>
        <Text style={{ color: theme.color.textSecondary, fontSize: 16 }}>取消</Text>
      </Pressable>
      <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>{title}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="保存"
        onPress={onSave}
        disabled={dimmed}
        hitSlop={10}
      >
        <Text
          style={{
            color: dimmed ? theme.color.textTertiary : theme.color.accent,
            fontSize: 16,
            fontWeight: '600',
          }}
        >
          {saving ? '保存中…' : '保存'}
        </Text>
      </Pressable>
    </View>
  );
}

/** 单行表单：左侧标签固定宽度，右侧是内容或输入。 */
export function FormRow({
  label,
  children,
  onPress,
  last = false,
}: {
  label: string;
  children: ReactNode;
  onPress?: () => void;
  last?: boolean;
}) {
  const theme = useAppTheme();
  const body = (
    <View
      style={[
        styles.row,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.border },
      ]}
    >
      <Text style={{ color: theme.color.textSecondary, fontSize: 15, width: 72 }}>{label}</Text>
      <View style={styles.rowBody}>{children}</View>
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

export function FormRowText({
  value,
  placeholder,
  onChangeText,
}: {
  value: string;
  placeholder: string;
  onChangeText: (next: string) => void;
}) {
  const theme = useAppTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.color.textTertiary}
      style={{ color: theme.color.textPrimary, fontSize: 15, paddingVertical: 2 }}
    />
  );
}

/** 多行备注。放在卡片里而不是单行，视觉上更像系统日历的「描述」。 */
export function FormTextArea({
  value,
  placeholder,
  onChangeText,
}: {
  value: string;
  placeholder: string;
  onChangeText: (next: string) => void;
}) {
  const theme = useAppTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.color.textTertiary}
      multiline
      accessibilityLabel={placeholder}
      style={{
        color: theme.color.textPrimary,
        fontSize: 15,
        minHeight: 88,
        textAlignVertical: 'top',
        paddingVertical: 2,
      }}
    />
  );
}

/** 单行文本输入（标题用）。 */
export function FormInput({
  value,
  placeholder,
  onChangeText,
  accessibilityLabel,
  keyboardType,
  autoFocus = false,
  fontSize = 15,
}: {
  value: string;
  placeholder: string;
  onChangeText: (next: string) => void;
  accessibilityLabel?: string;
  keyboardType?: KeyboardTypeOptions;
  autoFocus?: boolean;
  fontSize?: number;
}) {
  const theme = useAppTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.color.textTertiary}
      accessibilityLabel={accessibilityLabel ?? placeholder}
      keyboardType={keyboardType}
      autoFocus={autoFocus}
      style={{ color: theme.color.textPrimary, fontSize, paddingVertical: 2 }}
    />
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

/**
 * 分段选择器。最多 4 段，超出应改用二级选择页——
 * 选项一多，分段控件的点击目标就小到不可用了。
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  const theme = useAppTheme();
  return (
    <View style={[styles.segment, { borderColor: theme.color.border, borderRadius: theme.radius.input }]}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityLabel={`${label}-${option.label}`}
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[
              styles.segmentItem,
              index > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.color.border },
              selected && { backgroundColor: theme.color.accent },
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
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13 },
  rowBody: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  segment: { flexDirection: 'row', borderWidth: 1, overflow: 'hidden' },
  segmentItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 7 },
});
