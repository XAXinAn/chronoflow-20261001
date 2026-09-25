import { StyleSheet, Text, View } from 'react-native';

import type { IdentityView } from '../api/types';
import { Card, PrimaryButton, Screen } from '../components/ui';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import { ApiError } from '../api/client';
import { useState } from 'react';

/**
 * 登录后的身份选择页（spec §3.2）：
 * 一个账号可能同时拥有个人身份与多个组织身份，选定后才签发绑定该身份的令牌。
 */
export function IdentitySelectScreen({
  selectToken,
  identities,
  onBack,
}: {
  selectToken: string;
  identities: IdentityView[];
  onBack: () => void;
}) {
  const theme = useAppTheme();
  const { api, deviceId } = useRuntime();
  const { applyTokenResponse } = useAppSessionState();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (identityId: number) => {
    setBusyId(identityId);
    setError(null);
    try {
      const token = await api.selectIdentity(selectToken, identityId, deviceId);
      await applyTokenResponse(token);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '选择身份失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Screen style={styles.container}>
      <Text style={[styles.title, { color: theme.color.textPrimary }]}>选择身份</Text>
      <Text style={{ color: theme.color.textSecondary, marginBottom: theme.spacing.lg }}>
        该手机号下共有 {identities.length} 个身份
      </Text>

      {identities.map((identity) => (
        <View key={identity.identityId} style={{ marginBottom: theme.spacing.sm }}>
          <Card>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>
                  {identity.identityType === 'PERSONAL'
                    ? (identity.nickname ?? '个人身份')
                    : (identity.orgName ?? '组织身份')}
                </Text>
                <Text style={{ color: theme.color.textSecondary, fontSize: 13, marginTop: 2 }}>
                  {identity.identityType === 'PERSONAL'
                    ? '个人日历与待办'
                    : `${identity.departmentName ?? '未分配部门'}${identity.memberNo ? ` · ${identity.memberNo}` : ''}`}
                </Text>
              </View>
              <View style={{ width: 96 }}>
                <PrimaryButton
                  title={identity.identityType === 'PERSONAL' ? '进入' : '进入组织'}
                  onPress={() => void choose(identity.identityId)}
                  loading={busyId === identity.identityId}
                  disabled={busyId !== null && busyId !== identity.identityId}
                />
              </View>
            </View>
          </Card>
        </View>
      ))}

      {error ? <Text style={{ color: theme.color.danger, marginTop: theme.spacing.sm }}>{error}</Text> : null}

      <View style={{ height: theme.spacing.lg }} />
      <PrimaryButton title="换个手机号登录" onPress={onBack} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
