import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError } from '../api/client';
import { EmptyState, PrimaryButton, Screen } from '../components/ui';
import { useAppSessionState, useAppTheme } from '../context/AppContext';
import { OrgEventsScreen } from './OrgEventsScreen';

/**
 * 组织 tab（常驻，spec §4.2.3）。
 *
 * <p>三种状态：
 * 1. 还没绑定任何组织账号 → 空状态 + 「添加组织账号」入口（入口不能消失，否则用户找不到地方加）；
 * 2. 已选中某组织但本地没有它的令牌（换机、记录被清）→ 用组织编码 + 成员标识重新认领一次
 *    （认领是幂等的，不需要密码）；
 * 3. 有令牌 → 交给 OrgEventsScreen，**所有请求都用这个组织的令牌**，切组织就整套换掉。
 */
export function OrgTabScreen({
  onOpenAccounts,
  onCreateOrgEvent,
  onOpenRecognized,
  onEditOrgEvent,
}: {
  onOpenAccounts: () => void;
  /** 新建并下发组织日程（spec §4.2.2）；只有能下发的人才会在组织页看到入口 */
  onCreateOrgEvent: (dateKey: string) => void;
  /** 拍照识别结果确认页（选好下发对象后批量下发，spec §4.1.9） */
  onOpenRecognized: (payload: {
    drafts: import('../domain/vision').RecognizedEventDraft[];
    photoUri: string;
    sourceLabel: string;
    deviceFallbackReason: string | null;
    origin: 'ORG';
  }) => void;
  /** 编辑自己下发的组织日程（只有发起人能改） */
  onEditOrgEvent: (event: import('../api/types').OrgEvent) => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const {
    orgAccounts,
    activeOrgIdentityId,
    setActiveOrgIdentityId,
    refreshOrgAccounts,
    claimOrgAccount,
    orgApi,
    orgFocusDateKey,
    setOrgFocusDateKey,
  } = useAppSessionState();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshOrgAccounts().catch(() => undefined);
  }, [refreshOrgAccounts]);

  useEffect(() => {
    if (activeOrgIdentityId === null && orgAccounts.length > 0) {
      setActiveOrgIdentityId(orgAccounts[0].identityId);
    }
  }, [activeOrgIdentityId, orgAccounts, setActiveOrgIdentityId]);

  const active = orgAccounts.find((item) => item.identityId === activeOrgIdentityId) ?? null;
  const api = active ? orgApi(active.identityId) : null;

  const reClaim = useCallback(async () => {
    if (!active) {
      return;
    }
    try {
      await claimOrgAccount(active.orgCode, active.memberKey);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '进入组织失败，请重新添加组织账号');
    }
  }, [active, claimOrgAccount]);

  useEffect(() => {
    if (active && !api) {
      void reClaim();
    }
  }, [active, api, reClaim]);

  if (orgAccounts.length === 0) {
    return (
      <Screen>
        {/* 空状态与「待办」页一致：整屏居中（贴顶会让人以为上面还有内容没加载出来） */}
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            paddingHorizontal: theme.spacing.lg,
            paddingBottom: insets.bottom + theme.spacing.xl,
          }}
        >
          <EmptyState title="还没有组织账号" hint="组织账号由所在组织统一创建，用学号/工号添加" />
          <View style={{ marginTop: theme.spacing.lg }}>
            <PrimaryButton title="添加组织账号" onPress={onOpenAccounts} />
          </View>
          {error ? (
            <Text style={{ color: theme.color.danger, marginTop: 12, textAlign: 'center' }}>{error}</Text>
          ) : null}
        </View>
      </Screen>
    );
  }

  if (!active || !api) {
    return (
      <Screen>
        <View style={{ padding: theme.spacing.md, paddingTop: insets.top + theme.spacing.sm }}>
          <EmptyState title="正在进入组织" hint="本机没有该组织的登录记录时会自动重新认领一次" />
          <Pressable accessibilityRole="button" accessibilityLabel="账户管理" onPress={onOpenAccounts}>
            <Text style={{ color: theme.color.accent, textAlign: 'center', marginTop: 12 }}>账户管理</Text>
          </Pressable>
          {error ? (
            <Text style={{ color: theme.color.danger, marginTop: 12 }}>{error}</Text>
          ) : null}
        </View>
      </Screen>
    );
  }

  return (
    <OrgEventsScreen
      api={api}
      orgName={active.orgName}
      onOpenAccounts={onOpenAccounts}
      onCreateOrgEvent={onCreateOrgEvent}
      onOpenRecognized={onOpenRecognized}
      onEditOrgEvent={onEditOrgEvent}
      focusDateKey={orgFocusDateKey}
      onFocusApplied={() => setOrgFocusDateKey(null)}
    />
  );
}
