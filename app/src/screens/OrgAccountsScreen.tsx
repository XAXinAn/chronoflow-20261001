import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '../api/client';
import { EditorHeader } from '../components/form';
import { ListGroup, ListRow, ListSeparator, SectionHeader } from '../components/list';
import { Card, EmptyState, Pill } from '../components/ui';
import { useAppSessionState, useAppTheme } from '../context/AppContext';
import type { StoredOrgAccount } from '../auth/orgAccounts';

/**
 * 账户管理（spec §4.2.5）：管理「这台账号上登录过哪些组织账号」。
 *
 * - 添加 = 用「组织唯一 ID + 成员唯一识别 ID」认领一次组织账号（登录动作本身就是绑定）；
 * - 点条目 = 直接进入该组织的视图；
 * - 删除 = 删掉登录记录（本地令牌 + 服务端解绑），组织侧成员记录不受影响。
 */
export function OrgAccountsScreen({ onBack }: { onBack: () => void }) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const {
    orgAccounts,
    activeOrgIdentityId,
    setActiveOrgIdentityId,
    refreshOrgAccounts,
    claimOrgAccount,
    unlinkOrgAccount,
  } = useAppSessionState();

  const [org, setOrg] = useState('');
  const [memberKey, setMemberKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      await refreshOrgAccounts();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载组织账号失败');
    }
  }, [refreshOrgAccounts]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setError(null);
    if (!org.trim() || !memberKey.trim()) {
      setError('请填写组织唯一 ID 与成员唯一识别 ID（学号/工号）');
      return;
    }
    setBusy(true);
    try {
      const account = await claimOrgAccount(org.trim(), memberKey.trim());
      setActiveOrgIdentityId(account.identityId);
      setOrg('');
      setMemberKey('');
      onBack();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '添加组织账号失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = (account: StoredOrgAccount) => {
    Alert.alert(
      '删除登录记录',
      `将从这台账号上移除「${account.orgName}」的登录记录。组织里的成员身份不受影响，之后可以用同样的凭据重新添加。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await unlinkOrgAccount(account.identityId);
              } catch (cause) {
                setError(cause instanceof ApiError ? cause.message : '删除失败');
              }
            })();
          },
        },
      ],
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <EditorHeader
        title="账户管理"
        cancelLabel="返回"
        saveLabel="添加"
        savingLabel="添加中…"
        saving={busy}
        onCancel={onBack}
        onSave={() => void submit()}
      />

      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.md,
          paddingBottom: insets.bottom + theme.spacing.xxl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <SectionHeader title="添加组织账号" caption="由所在组织统一创建" />
        <Card>
          <View style={styles.field}>
            <Text style={{ color: theme.color.textSecondary, fontSize: 13 }}>组织唯一 ID</Text>
            <TextInput
              value={org}
              onChangeText={setOrg}
              placeholder="组织编码或数字 ID，如 XATECH"
              placeholderTextColor={theme.color.textTertiary}
              autoCapitalize="characters"
              accessibilityLabel="组织唯一 ID"
              style={{ color: theme.color.textPrimary, fontSize: 15, paddingVertical: 4 }}
            />
          </View>
          <View style={[styles.field, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border }]}>
            <Text style={{ color: theme.color.textSecondary, fontSize: 13 }}>
              成员唯一识别 ID（学号 / 工号）
            </Text>
            <TextInput
              value={memberKey}
              onChangeText={setMemberKey}
              placeholder="向组织管理员确认"
              placeholderTextColor={theme.color.textTertiary}
              autoCapitalize="characters"
              accessibilityLabel="成员唯一识别 ID"
              style={{ color: theme.color.textPrimary, fontSize: 15, paddingVertical: 4 }}
            />
          </View>
        </Card>

        {error ? (
          <Text style={{ color: theme.color.danger, marginTop: theme.spacing.md }}>{error}</Text>
        ) : null}
        {busy ? <ActivityIndicator color={theme.color.accent} style={{ marginTop: theme.spacing.md }} /> : null}

        <View style={{ marginTop: theme.spacing.xl }}>
          <SectionHeader
            title="已登录的组织账号"
            caption={orgAccounts.length > 0 ? `共 ${orgAccounts.length} 个` : undefined}
          />
          {orgAccounts.length === 0 ? (
            <EmptyState title="还没有组织账号" hint="填上面的两个 ID 添加，学号/工号可问组织管理员" />
          ) : (
            <ListGroup>
              {orgAccounts.map((account, index) => (
                <View key={account.identityId}>
                  {index > 0 ? <ListSeparator /> : null}
                  <ListRow
                    title={account.orgName}
                    subtitle={`${account.memberKey}${account.departmentName ? ` · ${account.departmentName}` : ''}`}
                    trailing={
                      <View style={styles.trailing}>
                        {account.identityId === activeOrgIdentityId ? <Pill text="当前" /> : null}
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`删除 ${account.orgName} 的登录记录`}
                          onPress={() => remove(account)}
                          hitSlop={10}
                        >
                          <Text style={{ color: theme.color.danger, fontSize: 13 }}>删除</Text>
                        </Pressable>
                      </View>
                    }
                    onPress={() => {
                      // 点条目 = 直接进这个组织的视图（spec §4.2.5）
                      setActiveOrgIdentityId(account.identityId);
                      onBack();
                    }}
                  />
                </View>
              ))}
            </ListGroup>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { paddingVertical: 10 },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
