import type { ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useAppTheme } from '../context/AppContext';

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useAppTheme();
  return (
    <View style={[styles.screen, { backgroundColor: theme.color.bg }, style]}>
      {children}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useAppTheme();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.color.surfaceRaised,
          borderColor: theme.color.border,
          borderRadius: theme.radius.card,
          shadowColor: theme.color.textPrimary,
          shadowOpacity: theme.scheme === 'dark' ? 0 : 0.06,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: theme.scheme === 'dark' ? 0 : 2,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function PrimaryButton({
  title,
  onPress,
  loading = false,
  disabled = false,
  tone = 'default',
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  /** 不可逆的危险操作（如注销账号）用 danger，与列表行的 danger 同一套语义 */
  tone?: 'default' | 'danger';
}) {
  const theme = useAppTheme();
  const inactive = disabled || loading;
  const background = tone === 'danger' ? theme.color.danger : theme.color.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      onPress={inactive ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderRadius: theme.radius.button,
          opacity: inactive ? 0.45 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed && !inactive ? 0.97 : 1 }],
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={theme.color.accentContrast} />
      ) : (
        <Text style={[styles.buttonText, { color: theme.color.accentContrast }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function GhostButton({ title, onPress }: { title: string; onPress: () => void }) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.ghost,
        {
          borderColor: theme.color.border,
          borderRadius: theme.radius.button,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Text style={{ color: theme.color.textPrimary }}>{title}</Text>
    </Pressable>
  );
}

export function Pill({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const theme = useAppTheme();
  const color =
    tone === 'success'
      ? theme.color.success
      : tone === 'warning'
        ? theme.color.warning
        : tone === 'danger'
          ? theme.color.danger
          : theme.color.textSecondary;
  return (
    <View style={[styles.pill, { borderColor: color, borderRadius: theme.radius.tag }]}>
      <Text style={{ color, fontSize: 12 }}>{text}</Text>
    </View>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  const theme = useAppTheme();
  return (
    <View style={styles.empty}>
      <Text style={{ color: theme.color.textSecondary, fontSize: 15 }}>{title}</Text>
      {hint ? (
        <Text style={{ color: theme.color.textTertiary, fontSize: 13, marginTop: theme.spacing.xs }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * 复选框。
 *
 * 合规场景（首启隐私政策弹窗、登录页、账号注销）**必须**用它而不是开关：
 * 审核规范要求「用勾选框形式的不得默认勾选」，`value` 由调用方传入，
 * 这里刻意不给默认值——少写一个 props 就编译不过，避免有人顺手写成默认勾上。
 */
export function Checkbox({
  value,
  onToggle,
  accessibilityLabel,
  children,
}: {
  value: boolean;
  onToggle: (next: boolean) => void;
  accessibilityLabel: string;
  children?: ReactNode;
}) {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: value }}
        accessibilityLabel={accessibilityLabel}
        onPress={() => onToggle(!value)}
        // 点击热区要比 20×20 的方框大得多，否则在手机上很难点中
        hitSlop={8}
        style={{ paddingVertical: 2 }}
      >
        <View
          style={[
            styles.checkbox,
            {
              borderColor: value ? theme.color.accent : theme.color.border,
              backgroundColor: value ? theme.color.accent : 'transparent',
              borderRadius: 4,
            },
          ]}
        >
          {value ? (
            <Ionicons name="checkmark" size={14} color={theme.color.accentContrast} />
          ) : null}
        </View>
      </Pressable>
      {children ? (
        <View style={{ flex: 1, marginLeft: 10 }}>
          {children}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  card: { borderWidth: 1, padding: 16 },
  button: { height: 48, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 16, fontWeight: '600' },
  ghost: { height: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  pill: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },
  empty: { alignItems: 'center', paddingVertical: 48 },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
