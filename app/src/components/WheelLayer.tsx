import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '../context/AppContext';

/**
 * 滚轮选择层（spec §7.6.7：日期时间选择用**弹层**，不必进二级页）。
 *
 * 贴在页面底部、不遮全屏、不压暗背景 —— 它是个选择层，不是模态弹窗：
 * 用户拨滚轮时还能看到上面的表单，知道自己改的是哪一栏。
 *
 * 与列表页「跳到指定日期」的那层是同一个交互语言，只是位置不同（那边浮在顶部月历之上）。
 */
export function WheelLayer({
  title,
  children,
  onCancel,
  onConfirm,
  confirmLabel = '确定',
}: {
  title: string;
  children: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityViewIsModal
      style={[
        styles.layer,
        {
          backgroundColor: theme.color.surfaceRaised,
          borderColor: theme.color.border,
          borderRadius: theme.radius.card,
          shadowColor: theme.color.textPrimary,
          paddingBottom: theme.spacing.sm + Math.max(insets.bottom, 8),
        },
      ]}
    >
      <Text style={{ color: theme.color.textSecondary, fontSize: 13 }}>{title}</Text>
      {children}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel="取消" onPress={onCancel} hitSlop={8}>
          <Text style={{ color: theme.color.textSecondary, fontSize: 15 }}>取消</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={confirmLabel}
          onPress={onConfirm}
          hitSlop={8}
        >
          <Text style={{ color: theme.color.accent, fontSize: 15, fontWeight: '600' }}>{confirmLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 12,
    elevation: 8,
  },
  actions: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 4 },
});
