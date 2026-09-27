import { useState } from 'react';
import { Alert, BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton, Screen } from '../components/ui';
import { LEGAL_DOCS, type LegalDoc } from '../domain/legal';
import { useAppTheme } from '../context/AppContext';
import { LegalScreen } from './LegalScreen';

/**
 * 首次启动的隐私政策同意页（spec §12；审核规范 §四「首次进入 APP 是否有隐私政策弹窗」）。
 *
 * 三个要点，缺一条就是审核里最常见的驳回理由：
 * 1. **显著方式提醒阅读**——整屏、正文摘要、三个可点开的链接，而不是登录页底下那行小字；
 * 2. **同意前不收集任何个人信息**——本页只读一份本地同意记录，不发任何网络请求；
 * 3. **不得默认同意**——「同意并继续」必须由用户主动点击，且 14 周岁以下单独提示
 *    （规范 §二-3(二)：首次打开 App 时要向用户明示儿童隐私政策内容）。
 */
export function PrivacyConsentScreen({
  onAgree,
  onDecline,
}: {
  /** 用户点了「同意并继续」 */
  onAgree: () => void;
  /** 用户点了「不同意」 */
  onDecline: () => void;
}) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const [viewing, setViewing] = useState<LegalDoc | null>(null);

  if (viewing) {
    return <LegalScreen doc={viewing} onBack={() => setViewing(null)} />;
  }

  const decline = () => {
    Alert.alert(
      '未同意隐私政策',
      '我们无法在没有您同意的情况下收集与使用个人信息，因此暂时无法为您提供服务。\n\n'
        + '您可以再次阅读隐私政策后决定是否同意。',
      [
        { text: '返回', style: 'cancel' },
        {
          text: '退出应用',
          style: 'destructive',
          // 规范 §三 二：拒绝的规范化表述可以是「退出应用」——但要给用户留一条回来的路，
          // 所以这里只退出，不删任何本地数据，下次打开还会看到这一页
          onPress: () => {
            onDecline();
            BackHandler.exitApp();
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingTop: insets.top + 32,
          paddingBottom: 32,
        }}
      >
        <Text style={[styles.title, { color: theme.color.textPrimary }]}>欢迎使用心安待办</Text>
        <Text style={{ color: theme.color.textSecondary, fontSize: 15, marginTop: 12, lineHeight: 24 }}>
          为了保障您的个人权益，在使用本产品前，请您仔细阅读
          <Text onPress={() => setViewing('privacy-policy')} style={{ color: theme.color.accent }}>
            {LEGAL_DOCS['privacy-policy'].label}
          </Text>
          与
          <Text onPress={() => setViewing('user-agreement')} style={{ color: theme.color.accent }}>
            {LEGAL_DOCS['user-agreement'].label}
          </Text>
          的完整内容。
        </Text>

        <View
          style={[
            styles.summary,
            { borderColor: theme.color.border, borderRadius: theme.radius.card },
          ]}
        >
          <SummaryLine text="我们只收集实现功能所必需的信息：手机号码（登录）、您填写的日程与待办、您主动选择的地点与图片。" />
          <SummaryLine text="不开启定位、相机、相册权限时，您仍可手工输入地点、新建日程与待办，基本功能不受影响。" />
          <SummaryLine text="本应用不含广告、不含统计分析 SDK，也不提供个性化推荐或定向推送。" />
          <SummaryLine text="您可以随时在「我的 → 隐私与合规 → 账号注销」注销账号并删除个人信息。" />
          <SummaryLine text="如果您是 14 周岁以下的儿童，请在监护人陪同下阅读并取得监护人同意后再使用。" />
        </View>

        <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 12, lineHeight: 20 }}>
          如果您是 14 周岁以下的儿童，请与监护人一起仔细阅读
          <Text onPress={() => setViewing('children-privacy')} style={{ color: theme.color.accent }}>
            {LEGAL_DOCS['children-privacy'].label}
          </Text>
          ，并在征得监护人同意后使用我们的产品与服务。
        </Text>

        <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 8, lineHeight: 20 }}>
          点击下方「同意并继续」即表示您已阅读并同意上述协议；若不同意，您可以选择退出应用。
        </Text>

        <View style={{ height: 20 }} />
        <PrimaryButton title="同意并继续" onPress={onAgree} />
        <Pressable
          accessibilityRole="button"
          onPress={decline}
          style={styles.decline}
        >
          <Text style={{ color: theme.color.textTertiary, fontSize: 15 }}>不同意</Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

function SummaryLine({ text }: { text: string }) {
  const theme = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', marginVertical: 6 }}>
      <Text style={{ color: theme.color.textTertiary, marginRight: 8 }}>·</Text>
      <Text style={{ color: theme.color.textSecondary, fontSize: 13, flex: 1, lineHeight: 21 }}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 26, fontWeight: '600', letterSpacing: -0.5 },
  summary: { borderWidth: 1, padding: 14, marginTop: 20 },
  decline: { height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
});
