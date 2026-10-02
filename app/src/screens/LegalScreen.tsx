import { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { LEGAL_DOCS, legalUrl, type LegalDoc } from '../domain/legal';
import { EditorHeader } from '../components/form';
import { useAppTheme, useRuntime } from '../context/AppContext';

/**
 * 合规文本页（隐私政策 / 用户协议 / 儿童声明 / 双清单）。
 *
 * **刻意不内嵌文本**，而是用 WebView 打开后端 `GET /api/v1/legal/{doc}`：
 * 商店审核要求「提交的链接内容与 App 内完全一致」，只有同源才能保证这件事，
 * 靠人工比对两份文本迟早会漂移（规范 §一-1 / §一-2⑥）。
 *
 * 页面由后端渲染成纯静态 HTML（无脚本、无跳转），所以这里也不需要处理任何消息。
 */
export function LegalScreen({ doc, onBack }: { doc: LegalDoc; onBack: () => void }) {
  const theme = useAppTheme();
  const { baseUrl } = useRuntime();
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const entry = LEGAL_DOCS[doc];
  const url = legalUrl(baseUrl, doc);

  const openInBrowser = () => {
    void Linking.openURL(url).catch(() =>
      Alert.alert('无法打开浏览器', `请手动访问：${url}`),
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <EditorHeader
        title={entry.title}
        cancelLabel="返回"
        onCancel={onBack}
        saveLabel="浏览器"
        onSave={openInBrowser}
      />

      {failed ? (
        <View style={styles.failed}>
          <Text style={{ color: theme.color.textSecondary, fontSize: 15, textAlign: 'center' }}>
            加载失败，请检查网络后重试
          </Text>
          <Text style={{ color: theme.color.textTertiary, fontSize: 12, marginTop: 8, textAlign: 'center' }}>
            {url}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setFailed(false);
              setReloadKey((current) => current + 1);
            }}
            style={{ marginTop: 16 }}
          >
            <Text style={{ color: theme.color.accent, fontSize: 15 }}>重新加载</Text>
          </Pressable>
        </View>
      ) : (
        <WebView
          key={reloadKey}
          source={{ uri: url }}
          onError={() => setFailed(true)}
          onHttpError={() => setFailed(true)}
          // 合规页面是纯静态文本，不需要脚本；关掉能少一类安全面
          javaScriptEnabled={false}
          style={{ backgroundColor: theme.color.bg }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  failed: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
});
