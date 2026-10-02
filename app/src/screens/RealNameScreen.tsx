import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { EditorHeader } from '../components/form';
import { Card, PrimaryButton, Screen } from '../components/ui';
import { askPermission } from '../components/permission';
import { useAppTheme, useRuntime } from '../context/AppContext';
import { userFacingError } from '../domain/errors';

/**
 * 实名认证**独立页**（spec §6.2）：走阿里云 CloudAuth 的 **H5 + iframe 内嵌**方案。
 *
 * <p>为什么不是「服务端拿到认证页地址、WebView 直接打开」那么简单：**`MetaInfo` 是必填参数，
 * 而且必须由客户端 Web SDK 实时采集**（官方说明：「MetaInfo 环境参数，需要通过客户端 SDK 获取」；
 * 返回字段 `CertifyUrl` 也要求「MetaInfo 正确传入」）。服务端编不出来——我们踩过：写了个假的
 * MetaInfo，阿里云只回 `CertifyId`、不回认证地址，界面看着像「服务不可用」。
 *
 * <p>所以这一页是**两步**：
 * 1. 先用一个极小的引导页加载官方 Web SDK（`jsvm_all.js`），调 `window.getMetaInfo()`，
 *    把结果 postMessage 给 RN；
 * 2. RN 把 MetaInfo + 姓名 + 身份证交给服务端换 `CertifyUrl`，再用第二张页面把 `CertifyUrl`
 *    塞进 `<iframe allow="camera">`（官方「iframe 内嵌接入」），认证结果由子页面 postMessage 回来。
 *
 * <p>⚠️ 两张页面都用 `baseUrl` 顶到 https：**摄像头要求安全上下文**（官方文档：页面必须 HTTPS 部署），
 * 我们的演示后端还是 http，所以这里靠 WebView 的 baseUrl 造出 https 源。
 */
const BOOTSTRAP = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://o.alicdn.com/yd-cloudauth/cloudauth-cdn/jsvm_all.js"></script>
</head><body><script>
(function(){
  function send(p){ window.ReactNativeWebView.postMessage(JSON.stringify(p)); }
  try {
    if (!window.getMetaInfo) { send({type:'error', message:'认证 SDK 没加载出来，请检查网络'}); return; }
    var m = window.getMetaInfo();
    // getMetaInfo() 返回的是**对象**，服务端要的是字符串（官方示例也是 JSON.stringify 后才发）
    send({type:'meta', metaInfo: typeof m === 'string' ? m : JSON.stringify(m)});
  } catch (e) { send({type:'error', message: String(e)}); }
})();
</script></body></html>`;

/** 第二张页面：把 CertifyUrl 放进 iframe，等子页面的 postMessage。`__CERTIFY_URL__` 是占位符。 */
const IFRAME_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{width:100%;height:100%;margin:0;background:#fff}#c,#c iframe{width:100%;height:100%;border:0}</style>
</head><body><div id="c"></div><script>
(function(){
  function send(p){ window.ReactNativeWebView.postMessage(JSON.stringify(p)); }
  // 小程序/iframe 场景要把短链换成 iframe 专用路径（官方示例）
  function toIframe(u){ return u.indexOf('/h5?')>=0 ? u.replace('/h5?','/h5iframe?') : (u.indexOf('/h5')>=0 && u.indexOf('/h5iframe')<0 ? u.replace('/h5','/h5iframe') : u); }
  try {
    var certifyUrl = toIframe(__CERTIFY_URL__);
    var allowedOrigin = new URL(certifyUrl).origin;
    var frame = document.createElement('iframe');
    frame.src = certifyUrl;
    frame.allow = 'camera;microphone;fullscreen';
    frame.setAttribute('allowusermedia','true');
    document.getElementById('c').appendChild(frame);
    window.addEventListener('message', function(event){
      if (event.origin !== allowedOrigin) return;
      var payload = typeof event.data === 'string' ? (function(){try{return JSON.parse(event.data)}catch(e){return null}})() : event.data;
      if (!payload || typeof payload !== 'object' || payload.code === undefined) return;
      send({type:'result', code: payload.code, subCode: payload.subCode || '', certifyId: (payload.extInfo||{}).certifyId || ''});
    }, {passive:true});
  } catch (e) { send({type:'error', message: String(e)}); }
})();
</script></body></html>`;

export function RealNameScreen({ onBack, onVerified }: { onBack: () => void; onVerified: () => void }) {
  const theme = useAppTheme();
  const { api } = useRuntime();
  const [realName, setRealName] = useState('');
  const [idCardNumber, setIdCard] = useState('');
  /** null = 还在填表；'collect' = 取 MetaInfo 的引导页；有值 = 跑认证的 iframe 页 */
  const [stage, setStage] = useState<'form' | 'collect'>('form');
  const [certifyUrl, setCertifyUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = realName.trim().length >= 2 && /^\d{17}[\dXx]$/.test(idCardNumber.trim());

  const start = async () => {
    // 摄像头权限：先我们自己说明 + 系统弹窗（拒绝就只是不认证，别的功能照常用）
    if (!(await askPermission('camera'))) {
      return;
    }
    setError(null);
    setStage('collect');
  };

  /** 引导页把 MetaInfo 送回来了 → 换认证地址。 */
  const onMeta = async (metaInfo: string) => {
    setBusy(true);
    try {
      const result = await api.initRealName({
        realName: realName.trim(),
        idCardNumber: idCardNumber.trim(),
        metaInfo,
      });
      setCertifyUrl(result.certifyUrl);
    } catch (cause) {
      setError(userFacingError(cause, '实名认证服务暂时不可用'));
      setStage('form');
    } finally {
      setBusy(false);
    }
  };

  /** iframe 里的子页面把结果 postMessage 回来了 → 用服务端二次确认（官方建议）。 */
  const onResult = async (certifyId: string, code: string, subCode: string) => {
    if (!certifyId) {
      setError(`认证未完成（code=${code} ${subCode}）`);
      setCertifyUrl(null);
      setStage('form');
      return;
    }
    setBusy(true);
    try {
      const result = await api.realNameResult(certifyId);
      if (result.verified) {
        onVerified();
        return;
      }
      setError(result.message ?? '认证未通过');
      setCertifyUrl(null);
      setStage('form');
    } catch (cause) {
      setError(userFacingError(cause, '查询认证结果失败'));
      setCertifyUrl(null);
      setStage('form');
    } finally {
      setBusy(false);
    }
  };

  const handleMessage = (data: string) => {
    let payload: { type?: string; metaInfo?: string; certifyId?: string; code?: string; subCode?: string; message?: string };
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (payload.type === 'meta' && payload.metaInfo) {
      void onMeta(payload.metaInfo);
    } else if (payload.type === 'result') {
      void onResult(payload.certifyId ?? '', payload.code ?? '', payload.subCode ?? '');
    } else if (payload.type === 'error') {
      setError(payload.message ?? '认证页加载失败');
      setCertifyUrl(null);
      setStage('form');
    }
  };

  // ---------------------------------------------------------------- 跑认证（iframe）
  if (stage === 'collect' && certifyUrl) {
    return (
      <View style={{ flex: 1 }}>
        <EditorHeader title="人脸认证" cancelLabel="返回" onCancel={() => { setCertifyUrl(null); setStage('form'); }} />
        <WebView
          originWhitelist={['*']}
          // baseUrl 顶成 https：摄像头需要安全上下文（演示后端还是 http，见文件头注释）
          source={{ html: IFRAME_PAGE.replace('__CERTIFY_URL__', JSON.stringify(certifyUrl)), baseUrl: 'https://chronoflow.demo/' }}
          // iframe 要开摄像头，必须放行 WebView 的媒体采集请求（Android 侧由它决定）
          mediaCapturePermissionGrantType="grant"
          allowsInlineMediaPlayback
          javaScriptEnabled
          domStorageEnabled
          onMessage={(event) => handleMessage(event.nativeEvent.data)}
        />
      </View>
    );
  }

  // ---------------------------------------------------------------- 取 MetaInfo（引导页）
  if (stage === 'collect') {
    return (
      <View style={{ flex: 1 }}>
        <EditorHeader title="实名认证" cancelLabel="返回" onCancel={() => setStage('form')} />
        <WebView
          originWhitelist={['*']}
          source={{ html: BOOTSTRAP, baseUrl: 'https://chronoflow.demo/' }}
          javaScriptEnabled
          onMessage={(event) => handleMessage(event.nativeEvent.data)}
        />
        {busy ? (
          <Text style={{ textAlign: 'center', padding: 12, color: theme.color.textSecondary }}>
            正在准备认证页面…
          </Text>
        ) : null}
      </View>
    );
  }

  // ---------------------------------------------------------------- 填表
  return (
    <Screen>
      <EditorHeader title="实名认证" cancelLabel="返回" onCancel={onBack} />
      <View style={styles.body}>
        <Card>
          <Text style={{ color: theme.color.textSecondary, fontSize: 13, lineHeight: 20 }}>
            实名认证由阿里云实人认证完成：填写姓名与身份证号后，会打开一个人脸活体检测页面。
            身份证号由服务端加密保存，不用于其它用途。
          </Text>
          <View style={{ height: theme.spacing.md }} />
          <Text style={[styles.label, { color: theme.color.textSecondary }]}>真实姓名</Text>
          <TextInput
            value={realName}
            onChangeText={setRealName}
            accessibilityLabel="真实姓名"
            placeholder="与身份证一致"
            placeholderTextColor={theme.color.textTertiary}
            style={[styles.input, { color: theme.color.textPrimary, borderColor: theme.color.border }]}
          />
          <View style={{ height: theme.spacing.md }} />
          <Text style={[styles.label, { color: theme.color.textSecondary }]}>身份证号</Text>
          <TextInput
            value={idCardNumber}
            onChangeText={setIdCard}
            autoCapitalize="characters"
            maxLength={18}
            accessibilityLabel="身份证号"
            placeholder="18 位"
            placeholderTextColor={theme.color.textTertiary}
            style={[styles.input, { color: theme.color.textPrimary, borderColor: theme.color.border }]}
          />
          {error ? (
            <Text style={{ color: theme.color.danger, fontSize: 13, marginTop: theme.spacing.sm }}>{error}</Text>
          ) : null}
          <View style={{ height: theme.spacing.lg }} />
          <PrimaryButton title="开始认证" onPress={() => void start()} loading={busy} disabled={!ready} />
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: 20, paddingTop: 16 },
  label: { fontSize: 13, marginBottom: 6 },
  input: { height: 48, borderWidth: 1, paddingHorizontal: 12, fontSize: 16, borderRadius: 10 },
});
