import { useEffect, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { EditorHeader } from '../components/form';
import { Chevron, ListGroup, ListRow, ListSeparator } from '../components/list';
import { Screen } from '../components/ui';
import { useAppScheme, useAppSessionState, useAppTheme, useRuntime } from '../context/AppContext';
import { useAppUpdate } from '../updater/AppUpdater';
import { LEGAL_DOCS, OPERATOR_NAME, type LegalDoc } from '../domain/legal';

/** 「我的」页的五个分类。**每一个都是独立路由**（`SettingsSection`），不是在同一页里换内容。 */
export type SettingsSectionKey = 'account' | 'preferences' | 'support' | 'legal' | 'about';

export const SETTINGS_SECTION_TITLES: Record<SettingsSectionKey, string> = {
  account: '账号与安全',
  preferences: '偏好',
  support: '支持',
  legal: '隐私与合规',
  about: '关于',
};

/**
 * 「我的」页里某一类的**独立子页**。
 *
 * <p>为什么是独立路由而不是「同一页里 setSection 换内容」：后者没有转场、没有自己的返回栈，
 * **安卓的系统返回键会直接退出 App**（而不是回到「我的」）——用户一眼就看出不对。
 * 现在它和其它页面一样走导航，返回键、手势、转场都对。
 */
export function SettingsSectionScreen({
  section,
  onBack,
  onOpenRealName,
  onOpenEmail,
  onOpenDeletion,
  onOpenFeedback,
  onOpenLegal,
}: {
  section: SettingsSectionKey;
  onBack: () => void;
  /** 实名认证是独立页（自己的 H5 流程），邮箱绑定也是——所以这里是两个各自的入口 */
  onOpenRealName: () => void;
  onOpenEmail: () => void;
  onOpenDeletion: () => void;
  onOpenFeedback: () => void;
  onOpenLegal: (doc: LegalDoc) => void;
}) {
  const theme = useAppTheme();
  const scheme = useAppScheme();
  const { check: checkUpdate, currentVersionName } = useAppUpdate();
  const { toggleScheme, notificationEnabled, setNotificationEnabled } = useAppSessionState();
  const { api } = useRuntime();
  /** 账号与安全那一屏要显示「已实名 / 未绑定」这类状态，进这一屏时拉一次 */
  const [security, setSecurity] = useState<{
    email: string | null;
    realName: string | null;
    realNameVerified: boolean;
  } | null>(null);

  useEffect(() => {
    if (section !== 'account') {
      return;
    }
    let alive = true;
    void api
      .meSecurity()
      .then((view) => {
        if (alive) {
          setSecurity(view);
        }
      })
      .catch(() => {
        // 读不到就按「未认证 / 未绑定」显示：这只是状态展示，不拦着用户点进去
      });
    return () => {
      alive = false;
    };
  }, [api, section]);

  return (
<Screen>
      <EditorHeader title={SETTINGS_SECTION_TITLES[section]} cancelLabel="返回" onCancel={onBack} />
      <View style={styles.body}>

      {section === 'account' ? (
        <ListGroup>
          <ListRow
            leading={<RowIcon name="shield-checkmark-outline" />}
            title="实名认证"
            subtitle={
              security?.realNameVerified
                ? `已实名${security.realName ? ` · ${maskName(security.realName)}` : ''}`
                : '未认证（可选，认证后可用于找回账号）'
            }
            onPress={onOpenRealName}
            trailing={<Chevron />}
          />
          <ListSeparator inset={52} />
          <ListRow
            leading={<RowIcon name="mail-outline" />}
            title="邮箱"
            subtitle={security?.email ? security.email : '未绑定（用于接收通知与找回账号）'}
            onPress={onOpenEmail}
            trailing={<Chevron />}
          />
          <ListSeparator inset={52} />
          <ListRow
            leading={<RowIcon name="trash-outline" tone="danger" />}
            title="账号注销"
            subtitle="删除个人信息并停用账号"
            tone="danger"
            onPress={onOpenDeletion}
            trailing={<Chevron />}
          />
        </ListGroup>
      ) : null}

      {section === 'preferences' ? (
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
          <ListSeparator inset={52} />
          {/*
            到点提醒的总开关（spec §4.5）。关掉时不只「以后不排」：已排的本机通知也会被撤掉，
            否则用户关掉之后照样被提醒，那个开关就成了摆设。
          */}
          <ListRow
            leading={<RowIcon name="notifications-outline" />}
            title="到点提醒"
            subtitle={notificationEnabled ? '日程与待办会按时提醒' : '已关闭，到点不会提醒'}
            trailing={
              <Switch
                value={notificationEnabled}
                onValueChange={setNotificationEnabled}
                accessibilityLabel="到点提醒"
                trackColor={{ false: theme.color.border, true: theme.color.accent }}
                thumbColor={theme.color.surfaceRaised}
              />
            }
          />
        </ListGroup>
      ) : null}

      {section === 'support' ? (
        <ListGroup>
          <ListRow
            leading={<RowIcon name="chatbubble-ellipses-outline" />}
            title="意见反馈"
            onPress={onOpenFeedback}
            trailing={<Chevron />}
          />
          <ListSeparator inset={52} />
          {/*
            手动检查更新（spec §4.1.11）：启动时已静默查过一次，这里是「我就是要现在查」——
            它**一定会给反馈**：有新版本弹更新说明，没有就明确说「已是最新版本」。
          */}
          <ListRow
            leading={<RowIcon name="cloud-download-outline" />}
            title="检查更新"
            subtitle={`当前版本 ${currentVersionName}`}
            onPress={() => void checkUpdate(true)}
            trailing={<Chevron />}
          />
        </ListGroup>
      ) : null}

      {section === 'legal' ? (
        <ListGroup>
          <ListRow
            leading={<RowIcon name="document-text-outline" />}
            title={LEGAL_DOCS['privacy-policy'].title}
            subtitle="我们收集什么、怎么用、怎么删"
            onPress={() => onOpenLegal('privacy-policy')}
            trailing={<Chevron />}
          />
          <ListSeparator inset={52} />
          <ListRow
            leading={<RowIcon name="reader-outline" />}
            title={LEGAL_DOCS['user-agreement'].title}
            onPress={() => onOpenLegal('user-agreement')}
            trailing={<Chevron />}
          />
          <ListSeparator inset={52} />
          <ListRow
            leading={<RowIcon name="shield-checkmark-outline" />}
            title={LEGAL_DOCS['children-privacy'].title}
            onPress={() => onOpenLegal('children-privacy')}
            trailing={<Chevron />}
          />
          <ListSeparator inset={52} />
          <ListRow
            leading={<RowIcon name="list-outline" />}
            title={LEGAL_DOCS['personal-info-collected'].title}
            onPress={() => onOpenLegal('personal-info-collected')}
            trailing={<Chevron />}
          />
          <ListSeparator inset={52} />
          <ListRow
            leading={<RowIcon name="share-social-outline" />}
            title={LEGAL_DOCS['shared-info-with-third-parties'].title}
            // 接入方变多了（高德 / 短信 / 邮件推送 / 实人认证 / 百炼），这里要跟着走，
            // 否则用户点进去看到的清单与入口描述对不上，等于「声明与实际不符」
            subtitle="高德地图、短信与邮件推送、实人认证、通义千问"
            onPress={() => onOpenLegal('shared-info-with-third-parties')}
            trailing={<Chevron />}
          />
        </ListGroup>
      ) : null}

      {section === 'about' ? (
        <ListGroup>
          <ListRow leading={<RowIcon name="business-outline" />} title="运营主体" subtitle={OPERATOR_NAME} />
          <ListSeparator inset={52} />
          {/*
            版本读**真机实际版本**（expo-constants），不再用硬编码常量：
            那个常量手动维护，早就停在 0.0.1 了，用户看到的就是「装了新版还写着旧版本」。
          */}
          <ListRow
            leading={<RowIcon name="information-circle-outline" />}
            title="版本"
            subtitle={currentVersionName}
          />
        </ListGroup>
      ) : null}
      </View>
    </Screen>
  );
}

/** 实名只露首字：截图 / 旁人一眼扫到全名不合适。 */
function maskName(name: string): string {
  return name.length <= 1 ? name : `${name.charAt(0)}${'*'.repeat(name.length - 1)}`;
}

/** 行首图标：与「我的」页同一套（统一线性图标 + 尺寸 + 颜色）。 */
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

const styles = StyleSheet.create({
  /** 内边距只给内容：页头必须通栏（和「新建日程」一致） */
  body: { flex: 1, paddingHorizontal: 20, paddingTop: 16 },
  rowIcon: { width: 36, alignItems: 'flex-start', justifyContent: 'center' },
});
