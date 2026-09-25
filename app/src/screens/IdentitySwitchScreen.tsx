import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { IdentityView } from '../api/types';
import { ApiError } from '../api/client';
import { ListGroup, ListRow, ListSeparator, SectionHeader } from '../components/list';
import { EmptyState, Screen } from '../components/ui';
import { useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';

/**
 * 切换身份：**独立一页列出全部身份**（含当前身份）。
 *
 * 原来是把「其他身份」直接摊在「我的」页里，有两个问题：
 * 身份多了会把页面撑得很长；而且看不到自己现在是哪个身份——那恰恰是切换时最需要的信息。
 * 首页只留一个入口按钮，点进来再看全量。
 */
export function IdentitySwitchScreen({
  onCancel,
  onSwitched,
}: {
  onCancel: () => void;
  onSwitched: () => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { api, deviceId } = useRuntime();
  const { session, applyTokenResponse } = useAppSessionState();

  const [identities, setIdentities] = useState<IdentityView[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingId, setSwitchingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setIdentities(await api.identities());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载身份列表失败');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const switchTo = async (target: IdentityView) => {
    if (!session) {
      return;
    }
    // 点当前身份就当确认，直接返回，不用白跑一次服务端
    if (target.identityId === session.identityId) {
      onCancel();
      return;
    }
    setSwitchingId(target.identityId);
    setError(null);
    try {
      // 走 applyTokenResponse 而不是直接 setState：必须写进安全存储，否则重启又回到原身份
      await applyTokenResponse(
        await api.switchIdentity(session.refreshToken, target.identityId, deviceId),
      );
      onSwitched();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '切换身份失败');
    } finally {
      setSwitchingId(null);
    }
  };

  return (
    <Screen>
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
        <Pressable accessibilityRole="button" accessibilityLabel="取消" onPress={onCancel} hitSlop={10}>
          <Text style={{ color: theme.color.textSecondary, fontSize: 16 }}>取消</Text>
        </Pressable>
        <Text style={{ color: theme.color.textPrimary, fontSize: 16, fontWeight: '600' }}>切换身份</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: theme.spacing.md, paddingBottom: theme.spacing.xxl }}>
        <SectionHeader title="全部身份" caption="无需重新登录" />

        {loading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator color={theme.color.accent} />
          </View>
        ) : null}

        {!loading && identities.length === 0 && !error ? (
          <EmptyState title="没有可切换的身份" />
        ) : null}

        {identities.length > 0 ? (
          <ListGroup>
            {identities.map((identity, index) => {
              const isCurrent = identity.identityId === session?.identityId;
              const busy = switchingId === identity.identityId;
              return (
                <View key={identity.identityId}>
                  {index > 0 ? <ListSeparator /> : null}
                  <ListRow
                    title={
                      identity.identityType === 'PERSONAL'
                        ? `个人身份 · ${identity.nickname ?? ''}`
                        : `组织 · ${identity.orgName ?? ''}`
                    }
                    subtitle={
                      identity.identityType === 'PERSONAL'
                        ? '个人日历与待办'
                        : identity.departmentName ?? '组织日程与回执'
                    }
                    onPress={switchingId === null ? () => void switchTo(identity) : undefined}
                    trailing={
                      busy ? (
                        <ActivityIndicator color={theme.color.accent} />
                      ) : isCurrent ? (
                        <Text style={{ color: theme.color.textSecondary, fontSize: 13 }}>当前 ✓</Text>
                      ) : (
                        <Text style={{ color: theme.color.textTertiary, fontSize: 16 }}>›</Text>
                      )
                    }
                  />
                </View>
              );
            })}
          </ListGroup>
        ) : null}

        {error ? (
          <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.md }}>{error}</Text>
        ) : null}
      </ScrollView>
    </Screen>
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
});
