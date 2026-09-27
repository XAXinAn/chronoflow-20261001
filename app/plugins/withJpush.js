/**
 * 极光推送（JPush）的 Expo 配置插件。
 *
 * 为什么需要这个插件：极光官方给的是**原生 Gradle 接入指南**（手改 `build.gradle` /
 * `AndroidManifest.xml` / `Application`）。我们跑的是 Expo 托管工程，没有 `android/` 目录可改，
 * 所以把这些原生改动固化成插件，`expo prebuild` / `eas build` 时自动注入。
 *
 * 插件只做三件事（正好对应官方指南的 ①② 两步）：
 *   1. 根 `build.gradle` 的 repositories 加华为 maven 仓库（厂商通道要用；FCM 我们不接，不加 google 仓库）
 *   2. `app/build.gradle` 注入 `JPUSH_PKGNAME / JPUSH_APPKEY / JPUSH_CHANNEL` 与厂商 key 的
 *      manifestPlaceholders（以及按需注入的厂商插件依赖）
 *   3. ABI 过滤，少打两份用不到的 so
 *
 * **不需要**往仓库里放那些 jar/aar：`jpush-react-native` 会从 Maven 拉
 * `cn.jiguang.sdk:jpush`，JCore 自动带上，receiver/service/provider 这些声明也在 AAR 自带的
 * manifest 里。手塞 jar 只会造成重复类。
 *
 * 版本按极光手动集成包（2026-09）里给的实际坐标：JPush **6.2.1**、JCore **5.5.1**，
 * 比网页指南里的 5.5.3 新。升级时两边一起改。
 */

const { withAppBuildGradle, withProjectBuildGradle } = require('@expo/config-plugins');

/** 与极光后台「应用包名」逐字一致；改了要同步 app.json 的 android.package 与极光后台。 */
const PKGNAME_PLACEHOLDER = '${applicationId}';

const JPUSH_VERSION = '6.2.1';

/** 厂商通道 → 依赖坐标 + 需要的 manifestPlaceholders（没配 key 的不要打开，否则编译期就报错）。 */
const VENDOR_CHANNELS = {
  huawei: {
    dependency: 'cn.jiguang.sdk.plugin:huawei:' + JPUSH_VERSION,
    knownDependency: 'com.huawei.hms:push:6.12.0.300',
    placeholders: [],
  },
  honor: {
    dependency: 'cn.jiguang.sdk.plugin:honor:' + JPUSH_VERSION,
    placeholders: ['HONOR_APPID'],
  },
  xiaomi: {
    dependency: 'cn.jiguang.sdk.plugin:xiaomi:' + JPUSH_VERSION,
    placeholders: ['XIAOMI_APPID', 'XIAOMI_APPKEY'],
  },
  oppo: {
    dependency: 'cn.jiguang.sdk.plugin:oppo:' + JPUSH_VERSION,
    placeholders: ['OPPO_APPKEY', 'OPPO_APPID', 'OPPO_APPSECRET'],
  },
  vivo: {
    dependency: 'cn.jiguang.sdk.plugin:vivo:' + JPUSH_VERSION,
    placeholders: ['VIVO_APPKEY', 'VIVO_APPID'],
  },
};

function withJpushRepositories(config) {
  return withProjectBuildGradle(config, (gradle) => {
    if (gradle.modResults.language !== 'groovy') {
      return gradle;
    }
    const contents = gradle.modResults.contents;
    // allprojects.repositories 里补华为仓库（幂等：已经加过就跳过）
    if (!contents.includes('developer.huawei.com/repo')) {
      gradle.modResults.contents = contents.replace(
        /allprojects\s*\{[\s\S]*?repositories\s*\{/,
        (match) =>
          match +
          "\n        // 极光华为厂商通道需要（见 app/plugins/withJpush.js）" +
          "\n        maven { url 'https://developer.huawei.com/repo/' }"
      );
    }
    return gradle;
  });
}

function placeholderBlock(options) {
  const lines = [
    `            JPUSH_PKGNAME : ${PKGNAME_PLACEHOLDER},`,
    `            JPUSH_APPKEY  : "${options.appKey}",`,
    // 渠道号只影响极光后台的统计维度，不是密钥
    `            JPUSH_CHANNEL : "${options.channel || 'default_developer'}",`,
  ];
  const enabled = options.vendorChannels || {};
  for (const [name, keys] of Object.entries(VENDOR_CHANNELS)) {
    const values = enabled[name];
    if (!values) {
      continue;
    }
    for (const key of keys.placeholders) {
      if (!values[key]) {
        throw new Error(
          `withJpush: 启用厂商通道 ${name} 必须提供 ${key}（在 app.json 的插件配置里，或从环境变量注入）`
        );
      }
      lines.push(`            ${key} : "${values[key]}",`);
    }
  }
  return lines.join('\n');
}

function withJpushAndroidGradle(config, options) {
  return withAppBuildGradle(config, (gradle) => {
    if (gradle.modResults.language !== 'groovy') {
      return gradle;
    }
    let contents = gradle.modResults.contents;

    // ① manifestPlaceholders：已经手写过就不重复注入
    if (!contents.includes('JPUSH_APPKEY')) {
      const block = `        manifestPlaceholders = [\n${placeholderBlock(options)}\n        ]\n`;
      if (/defaultConfig\s*\{/.test(contents)) {
        contents = contents.replace(/defaultConfig\s*\{/, (match) => match + '\n' + block);
      } else {
        throw new Error('withJpush: app/build.gradle 里找不到 defaultConfig，插件需要更新');
      }
    }

    // ② ABI 过滤：只打 arm 架构（模拟器 x86 用不到极光的 so）
    if (!contents.includes('abiFilters')) {
      contents = contents.replace(
        /defaultConfig\s*\{/,
        (match) =>
          match +
          `\n        ndk {\n            abiFilters 'armeabi-v7a', 'arm64-v8a'\n        }`
      );
    }

    // ③ 依赖：极光本身 + 按需的厂商插件
    const deps = [`    implementation 'cn.jiguang.sdk:jpush:${JPUSH_VERSION}'`];
    const enabled = options.vendorChannels || {};
    for (const [name, meta] of Object.entries(VENDOR_CHANNELS)) {
      if (!enabled[name]) {
        continue;
      }
      if (meta.knownDependency) {
        deps.push(`    implementation '${meta.knownDependency}'`);
      }
      deps.push(`    implementation '${meta.dependency}'`);
    }
    if (!contents.includes('cn.jiguang.sdk:jpush')) {
      contents = /^dependencies\s*\{/m.test(contents)
        ? contents.replace(/dependencies\s*\{/, (match) => match + '\n' + deps.join('\n'))
        : contents + '\n\ndependencies {\n' + deps.join('\n') + '\n}\n';
    }

    gradle.modResults.contents = contents;
    return gradle;
  });
}

module.exports = function withJpush(config, options = {}) {
  if (!options.appKey) {
    throw new Error('withJpush: 缺少 appKey（极光后台「应用设置」里的 AppKey）');
  }
  config = withJpushRepositories(config);
  config = withJpushAndroidGradle(config, options);
  return config;
};
