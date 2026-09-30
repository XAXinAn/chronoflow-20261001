import type { ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
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
  cancelLabel = '取消',
  saveLabel = '保存',
  savingLabel = '保存中…',
  titleOnly = false,
  right,
}: {
  title: string;
  onCancel: () => void;
  onSave: () => void;
  saving?: boolean;
  saveDisabled?: boolean;
  /** 文案可按页面定制（例如反馈页是「提交」而不是「保存」） */
  cancelLabel?: string;
  saveLabel?: string;
  savingLabel?: string;
  /** 作为一级页面（底部导航的 tab）用时只留标题，不显示取消/保存 */
  titleOnly?: boolean;
  /**
   * 标题栏右侧的操作位（一级页面用）。
   *
   * <p>给它留的是和左侧占位**等宽**的一格，标题因此仍居中；不传就是原来那样空着。
   * 页面级的零散操作放这里，比在标题下面单起一行好看得多——那一行会把内容整体往下压，
   * 而且看起来像是「标题的一部分」。
   */
  right?: ReactNode;
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
      {titleOnly ? (
        <>
          <View style={{ width: 56 }} />
          <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>{title}</Text>
          <View style={{ width: 56, alignItems: 'flex-end' }}>{right}</View>
        </>
      ) : (
        <>
      <Pressable accessibilityRole="button" accessibilityLabel="取消" onPress={onCancel} hitSlop={10}>
        <Text style={{ color: theme.color.textSecondary, fontSize: 16 }}>{cancelLabel}</Text>
      </Pressable>
      <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>{title}</Text>
    <Pressable
      accessibilityRole="button"
      // 无障碍标签跟随可见文案：反馈页是「提交」、选人页是「确定」，
      // 一直念「保存」会让读屏用户不知道该按哪个
      accessibilityLabel={saveLabel}
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
          {saving ? savingLabel : saveLabel}
        </Text>
      </Pressable>
        </>
      )}
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

/**
 * 选项行（单选 / 多选都用它）。
 *
 * 用于「重复频率 / 结束条件 / 提醒提前量」这类**选项列表**：段控件最多 4 段，
 * 重复有 5 个频率、提醒有 6 个预置，挤进段控件后点击目标小到点不准（spec §7.6.7）。
 *
 * 选中态用右侧对勾而不是颜色填充：这两个页面里「已选」和「当前项」要能一眼分清，
 * 而且深色模式下纯色块的对比度不稳定。
 */
export function CheckRow({
  label,
  selected,
  onPress,
  last = false,
  role = 'button',
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  last?: boolean;
  role?: 'button' | 'radio' | 'checkbox';
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={role === 'radio' ? { selected } : { checked: selected }}
      onPress={onPress}
      style={[
        styles.row,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.border },
      ]}
    >
     <Text style={{ color: theme.color.textPrimary, fontSize: 15, flex: 1 }}>{label}</Text>
      {selected ? <Ionicons name="checkmark" size={18} color={theme.color.accent} /> : null}
    </Pressable>
  );
}

/**
 * 可点行右侧的「当前值 + ›」。
 *
 * 地点、重复、提醒、时间这些行长得一模一样，之前每处都手写一遍样式与箭头，
 * 结果很容易出现「有的行箭头是 ›、有的没箭头、有的颜色不一样」。抽成一个组件。
 */
export function FormRowValue({
  text,
  placeholder,
}: {
  /** 已有值时显示它；为空时显示 placeholder（用更浅的颜色） */
  text: string | null;
  placeholder: string;
}) {
  const theme = useAppTheme();
  const filled = Boolean(text);
  return (
    <>
      <Text
        style={{
          color: filled ? theme.color.textPrimary : theme.color.textTertiary,
          fontSize: 15,
          flex: 1,
          textAlign: 'right',
        }}
      >
        {filled ? text : placeholder}
      </Text>
      <Text style={{ color: theme.color.textTertiary, fontSize: 16, marginLeft: 6 }}>›</Text>
    </>
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
