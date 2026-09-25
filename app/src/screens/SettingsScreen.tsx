import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '../api/client';
import type { IdentityView } from '../api/types';
import { ListGroup, ListRow, ListSeparator, SectionHeader } from '../components/list';
import { useAppScheme, useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';

export function SettingsScreen() {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const scheme = useAppScheme();
  const { api, baseUrl, deviceId } = useRuntime();
  const { session, toggleScheme, applyTokenResponse, signOut } = useAppSessionState();

  const [identities, setIdentities] = useState<IdentityView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

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

  const switchTo = async (target: IdentityView) => {
    if (!session) {
      return;
    }
    setSwitching(true);
    setError(null);
    try {
      const token = await api.switchIdentity(session.refreshToken, target.identityId, deviceId);
      await applyTokenResponse(token);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '切换身份失败');
    } finally {
      setSwitching(false);
    }
  };

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
  const otherIdentities = identities.filter((item) => item.identityId !== session?.identityId);

  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: theme.spacing.md,
        paddingTop: insets.top + theme.spacing.sm,
        paddingBottom: theme.spacing.xxl,
      }}
      style={{ backgroundColor: theme.color.bg }}
    >
      <View style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader title="账号" />
        <ListGroup>
          <ListRow title={session?.nickname ?? '未命名'} subtitle={isOrg ? '组织身份' : '个人身份'} />
          <ListSeparator />
          <ListRow
            title="身份 ID"
            subtitle={`账号 #${session?.accountId ?? '-'}`}
            trailing={
              <Text style={{ color: theme.color.textTertiary, fontSize: 13 }}>#{session?.identityId}</Text>
            }
          />
        </ListGroup>
      </View>

      {otherIdentities.length > 0 ? (
        <View style={{ marginBottom: theme.spacing.lg }}>
          <SectionHeader title="切换身份" caption="无需重新登录" />
          <ListGroup>
            {otherIdentities.map((identity, index) => (
              <View key={identity.identityId}>
                {index > 0 ? <ListSeparator /> : null}
                <ListRow
                  title={
                    identity.identityType === 'PERSONAL'
                      ? `个人身份 · ${identity.nickname ?? ''}`
                      : `组织 · ${identity.orgName ?? ''}`
                  }
                  subtitle={identity.identityType === 'PERSONAL' ? undefined : identity.departmentName ?? undefined}
                  onPress={switching ? undefined : () => void switchTo(identity)}
                  trailing={<Text style={{ color: theme.color.textTertiary, fontSize: 16 }}>›</Text>}
                />
              </View>
            ))}
          </ListGroup>
        </View>
      ) : null}

      <View style={{ marginBottom: theme.spacing.lg }}>
        <SectionHeader title="偏好" />
        <ListGroup>
          <ListRow
            title="深色模式"
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
          <ListRow title="接口地址" subtitle={baseUrl} />
          <ListSeparator />
          <ListRow title="版本" subtitle="0.1.0" />
        </ListGroup>
      </View>

      {error ? (
        <Text style={{ color: theme.color.danger, fontSize: 13, marginBottom: theme.spacing.md }}>
          {error}
        </Text>
      ) : null}

      <ListGroup>
        <ListRow title="退出登录" tone="danger" onPress={() => void logout()} />
      </ListGroup>
    </ScrollView>
  );
}
