import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../context/AppContext';

/**
 * 分组列表：容器 + 细线分隔的条目。
 *
 * 比「每个条目一张卡片」轻得多——卡片多了之后页面全是边框，反而看不清层次。
 * 分组标题用次级文字色、字号 13，符合 spec §7.6 的字阶。
 */
export function ListGroup({ children }: { children: ReactNode }) {
  const theme = useAppTheme();
  return (
    <View
      style={[
        styles.group,
        {
          backgroundColor: theme.color.surfaceRaised,
          borderColor: theme.color.border,
          borderRadius: theme.radius.card,
        },
      ]}
    >
      {children}
    </View>
  );
}

export function SectionHeader({ title, caption }: { title: string; caption?: string }) {
  const theme = useAppTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text style={[styles.sectionTitle, { color: theme.color.textSecondary }]}>{title}</Text>
      {caption ? (
        <Text style={{ color: theme.color.textTertiary, fontSize: 13 }}>{caption}</Text>
      ) : null}
    </View>
  );
}

export function ListSeparator({ inset = 16 }: { inset?: number }) {
  const theme = useAppTheme();
  return <View style={{ height: 1, marginLeft: inset, backgroundColor: theme.color.border }} />;
}

interface ListRowProps {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  /** 危险操作（如退出登录）用语义色，但仍然是普通条目，不放大成主按钮 */
  tone?: 'default' | 'danger';
  strikethrough?: boolean;
}

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  tone = 'default',
  strikethrough = false,
}: ListRowProps) {
  const theme = useAppTheme();
  const titleColor = tone === 'danger' ? theme.color.danger : theme.color.textPrimary;

  const body = (
    <View style={styles.row}>
      {leading}
      <View style={styles.rowBody}>
        <Text
          style={{
            color: titleColor,
            fontSize: 16,
            textDecorationLine: strikethrough ? 'line-through' : 'none',
          }}
          numberOfLines={2}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginTop: 3 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );

  if (!onPress) {
    return body;
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: { borderWidth: 1, overflow: 'hidden' },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  sectionTitle: { fontSize: 13, fontWeight: '600', letterSpacing: 0.2 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  rowBody: { flex: 1, marginLeft: 0 },
});
