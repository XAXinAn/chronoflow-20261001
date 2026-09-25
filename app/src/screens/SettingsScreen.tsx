import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import type { IdentityView } from '../api/types';
import { ListGroup, ListRow, ListSeparator, SectionHeader } from '../components/list';
import { useAppScheme, useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';

/**
 * 「我的」页。
 *
 * 结构对齐商用 App 的通行做法：**顶部个人信息区 + 若干带图标的分组列表**。
 * 之前那版是一行行纯文字，读起来像配置文件——分组、图标、层级都是靠视觉建立的，
 * 不该让用户去逐行读文字。
 */
export function SettingsScreen({ onOpenIdentitySwitch }: { onOpenIdentitySwitch: () => void }) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const scheme = useAppScheme();
  const { api, baseUrl } = useRuntime();
  const { session, toggleScheme, signOut } = useAppSessionState();

  const [identities, setIdentities] = useState<IdentityView[]>([]);

  const loadIdentities = useCallback(async () => {
    try {
      setIdentities(await api.identities());
    } catch {
      // 身份列表拿不到不影响本页其他内容
    }
  }, [api]);

  useEffect(() => {
    void loadIdentities();
  }, [loadIdentities]);

  const logout = async () => {
    if (session) {
      try {
        await api.logout(session.refreshToken);
      } catch {
        // 服务端吊销失败也要清掉本地会话
      }
    }
    await signOut();
  };

  const isOrg = session?.identityType === 'ORG_MEMBER';
  const nickname = session?.nickname ?? '未命名';
  const otherIdentityCount = identities.filter((item) => item.identityId !== session?.identityId).length;

  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: theme.spacing.md,
        paddingTop: insets.top + theme.spacing.sm,
        paddingBottom: theme.spacing.xxl,
      }}
      style={{ backgroundColor: theme.color.bg }}
    >
      {/* 个人信息区：头像只放昵称首字，黑白模式下不需要真头像也不显空 */}
      <View style={[styles.profile, { marginBottom: theme.spacing.lg }]}>
        <View
          style={[
            styles.avatar,
            { backgroundColor: theme.color.accent, borderColor: theme.color.border },
          ]}
        >
          <Text style={{ color: theme.color.accentContrast, fontSize: 24, fontWeight: '600' }}>
            {[...nickname][0] ?? '·'}
          </Text>
        </View>
        <View style={{ flex: 1, marginLeft: theme.spacing.md }}>
          <Text style={{ color: theme.color.textPrimary, fontSize: 22, fontWeight: '600' }} numberOfLines={1}>
            {nickname}
          </Text>
          <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginTop: 4 }}>
            {isOrg ? '组织身份' : '个人身份'} · 身份 #{session?.identityId ?? '-'}
          </Text>
          <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 2 }}>
            账号 #{session?.accountId ?? '-'}
          </Text>
        </View>
      </View>

      <View style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader title="账号" />
        <ListGroup>
          <ListRow
            leading={<RowIcon name="swap-horizontal-outline" />}
            title="切换身份"
            subtitle={otherIdentityCount > 0 ? `还可切换 ${otherIdentityCount} 个身份` : '暂无其他身份'}
            onPress={onOpenIdentitySwitch}
            trailing={<Chevron />}
          />
        </ListGroup>
      </View>

      <View style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader title="偏好" />
        <ListGroup>
          <ListRow
            leading={<RowIcon name="moon-outline" />}
            title="深色模式"
            subtitle={scheme === 'dark' ? '已开启' : '跟随浅色'}
            trailing={
              <Switch
                value={scheme === 'dark'}
                onValueChange={toggleScheme}
                accessibilityLabel="深色模式"
                trackColor={{ false: theme.color.border, true: theme.color.accent }}
                thumbColor={theme.color.surfaceRaised}
              />
            }
          />
        </ListGroup>
      </View>

      <View style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader title="关于" />
        <ListGroup>
          <ListRow
            leading={<RowIcon name="link-outline" />}
            title="接口地址"
            subtitle={baseUrl}
          />
          <ListSeparator inset={52} />
          <ListRow leading={<RowIcon name="information-circle-outline" />} title="版本" subtitle="0.1.0" />
        </ListGroup>
      </View>

      <ListGroup>
        <ListRow
          leading={<RowIcon name="log-out-outline" tone="danger" />}
          title="退出登录"
          tone="danger"
          onPress={() => void logout()}
        />
      </ListGroup>
    </ScrollView>
  );
}

/** 行首图标：统一线性图标 + 统一的尺寸与颜色，避免每行各写一套。 */
function RowIcon({ name, tone = 'default' }: { name: string; tone?: 'default' | 'danger' }) {
  const theme = useAppTheme();
  return (
    <View style={styles.rowIcon}>
      <Ionicons
        name={name as never}
        size={20}
        color={tone === 'danger' ? theme.color.danger : theme.color.textSecondary}
      />
    </View>
  );
}

function Chevron() {
  const theme = useAppTheme();
  return <Text style={{ color: theme.color.textTertiary, fontSize: 16 }}>›</Text>;
}

const styles = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowIcon: { width: 36, alignItems: 'flex-start' },
});
