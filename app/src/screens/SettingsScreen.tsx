import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import type { IdentityView } from '../api/types';
import { ApiError } from '../api/client';
import { toStoredSession } from '../auth/session';
import { Card, GhostButton, PrimaryButton, Screen } from '../components/ui';
import { useAppScheme, useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';

export function SettingsScreen() {
  const theme = useAppTheme();
  const scheme = useAppScheme();
  const { api, baseUrl } = useRuntime();
  const { session, setSession, toggleScheme } = useAppSessionState();

  const [identities, setIdentities] = useState<IdentityView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setIdentities(await api.identities());
      } catch {
        // 拿到身份列表失败不影响本页其他功能
      }
    })();
  }, [api]);

  const switchTo = async (target: IdentityView) => {
    if (!session) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await api.switchIdentity(session.refreshToken, target.identityId, 'this-device');
      await setSession(toStoredSession(token, Date.now()));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '切换身份失败');
    } finally {
      setBusy(false);
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
    await setSession(null);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.md }}>
        <Text style={[styles.title, { color: theme.color.textPrimary }]}>我的</Text>

        <Card style={{ marginBottom: theme.spacing.md }}>
          <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>
            {session?.nickname ?? '未命名'}
          </Text>
          <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginTop: 2 }}>
            {session?.identityType === 'ORG_MEMBER' ? `组织身份 · 组织 #${session.orgId}` : '个人身份'}
          </Text>
          <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 6 }}>
            账号 #{session?.accountId} · 身份 #{session?.identityId}
          </Text>
        </Card>

        {identities.length > 1 ? (
          <Card style={{ marginBottom: theme.spacing.md }}>
            <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginBottom: theme.spacing.sm }}>
              切换身份（无需重新登录）
            </Text>
            {identities
              .filter((identity) => identity.identityId !== session?.identityId)
              .map((identity) => (
                <View key={identity.identityId} style={{ marginBottom: theme.spacing.xs }}>
                  <GhostButton
                    title={identity.identityType === 'PERSONAL'
                      ? `个人身份 · ${identity.nickname ?? ''}`
                      : `组织 · ${identity.orgName ?? ''}`}
                    onPress={() => void switchTo(identity)}
                  />
                </View>
              ))}
            {busy ? (
              <Text style={{ color: theme.color.textTertiary, fontSize: 12 }}>切换中…</Text>
            ) : null}
          </Card>
        ) : null}

        <Card style={{ marginBottom: theme.spacing.md }}>
          <View style={styles.switchRow}>
            <Text style={{ color: theme.color.textPrimary }}>深色模式</Text>
            <Switch
              value={scheme === 'dark'}
              onValueChange={toggleScheme}
              accessibilityLabel="深色模式"
              trackColor={{ false: theme.color.border, true: theme.color.accent }}
              thumbColor={theme.color.surfaceRaised}
            />
          </View>
          <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: theme.spacing.sm }}>
            接口地址：{baseUrl}
          </Text>
        </Card>

        {error ? (
          <Text style={{ color: theme.color.danger, marginBottom: theme.spacing.sm }}>{error}</Text>
        ) : null}

        <PrimaryButton title="退出登录" onPress={() => void logout()} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '600', marginBottom: 16 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
