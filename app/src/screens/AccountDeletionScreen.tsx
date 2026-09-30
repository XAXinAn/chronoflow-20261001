import { useState } from 'react';
import { userFacingError } from '../domain/errors';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Checkbox, PrimaryButton } from '../components/ui';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import { LEGAL_DOCS, type LegalDoc } from '../domain/legal';

/**
 * 账号注销（spec §12；审核规范 §2.7）。
 *
 * 规范要求「在隐私政策中说明注销步骤流程，并在 APP 内有对应的注销功能按钮」。
 * 两件事都在这里闭环：条文写在《时纪流隐私政策》第七章第 4 节，
 * 而按钮就是这一页——**路径文案与实际入口必须逐字一致**，否则审核会认为「找不到入口」。
 *
 * 注销是不可逆的，所以：先把后果逐条写清楚 → 用户主动勾选「我已了解」→ 再二次确认。
 */
const CONSEQUENCES = [
  '您的账号将立即失效，所有设备同时退出登录。',
  '个人日历、日程、待办、提醒与图片将被删除，且无法恢复。',
  '您提交的意见反馈将被删除。',
  '手机号、密码与第三方绑定信息将被清空，该账号无法再登录。',
  '您与我们绑定的组织成员身份将被解除；组织侧成员记录保留，您可以用原学号/工号重新认领。',
  '同一手机号可以重新注册，但那将是一个全新的账号。',
];

export function AccountDeletionScreen({
  onBack,
  onOpenLegal,
}: {
  onBack: () => void;
  onOpenLegal: (doc: LegalDoc) => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();
  const { signOut } = useAppSessionState();

  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount();
      // 服务端已经删干净了；本地会话与各组织登录记录也要一起清掉，
      // 否则下次冷启动还会拿一个已被吊销的令牌去换会话
      await signOut();
    } catch (cause) {
      setError(userFacingError(cause, '注销失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: theme.spacing.md,
        paddingTop: insets.top + theme.spacing.sm,
        paddingBottom: theme.spacing.xxl,
      }}
      style={{ backgroundColor: theme.color.bg }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="返回"
        onPress={onBack}
        hitSlop={8}
        style={{ height: 44, justifyContent: 'center' }}
      >
        <Ionicons name="chevron-back" size={22} color={theme.color.textPrimary} />
      </Pressable>

      <Text style={{ color: theme.color.textPrimary, fontSize: 22, fontWeight: '600', marginTop: 4 }}>
        注销账号
      </Text>
      <Text style={{ color: theme.color.textSecondary, fontSize: 14, marginTop: 8, lineHeight: 22 }}>
        注销后我们将立即删除或匿名化您的个人信息，此操作不可撤销。请您确认已了解以下后果：
      </Text>

      <View
        style={[
          styles.card,
          { borderColor: theme.color.border, borderRadius: theme.radius.card, marginTop: 16 },
        ]}
      >
        {CONSEQUENCES.map((item) => (
          <View key={item} style={{ flexDirection: 'row', marginVertical: 5 }}>
            <Text style={{ color: theme.color.danger, marginRight: 8 }}>·</Text>
            <Text style={{ color: theme.color.textSecondary, fontSize: 13, flex: 1, lineHeight: 21 }}>
              {item}
            </Text>
          </View>
        ))}
      </View>

      <Pressable
        accessibilityRole="link"
        onPress={() => onOpenLegal('privacy-policy')}
        style={{ marginTop: 14 }}
      >
        <Text style={{ color: theme.color.accent, fontSize: 13 }}>
          查看 {LEGAL_DOCS['privacy-policy'].label} 第七章「您如何管理您的个人信息」
        </Text>
      </Pressable>

      <View style={{ marginTop: 20 }}>
        <Checkbox
          value={acknowledged}
          onToggle={setAcknowledged}
          accessibilityLabel="我已了解上述后果"
        >
          <Text style={{ color: theme.color.textPrimary, fontSize: 14, lineHeight: 21 }}>
            我已了解上述后果，自愿注销账号
          </Text>
        </Checkbox>
      </View>

      {error ? (
        <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: 12 }}>{error}</Text>
      ) : null}

      <View style={{ height: 24 }} />
      <PrimaryButton
        title="确认注销"
        tone="danger"
        onPress={() => void submit()}
        loading={busy}
        disabled={!acknowledged}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: 14 },
});
