const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * 让 **release** 包也能访问我们的 HTTP 演示后端（spec §10.1）。
 *
 * 背景：Android 9+ 默认禁止明文 HTTP。Expo 只**给 debug 构建**自动加
 * `android:usesCleartextTraffic="true"`（它的 AndroidManifest 里 debug 有一份、main 没有），
 * 于是 release 包一旦指向 `http://`，**所有请求都会在客户端被拦掉**：
 * 表现是「验证码发送失败」，而且服务器上一行访问日志都没有——请求根本没出手机。
 * 2026-10-01 给演示机发的 release 包就是这么翻的车。
 *
 * ⚠️ 这是**给内部演示用的临时措施**：`http://` 意味着流量不加密，正式发版必须先把 API
 * 换成 HTTPS（域名 + 证书），然后**删掉这个插件**与 app.json 里的注册。
 */
module.exports = function withCleartextHttp(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (application) {
      application.$['android:usesCleartextTraffic'] = 'true';
    }
    return config;
  });
};
