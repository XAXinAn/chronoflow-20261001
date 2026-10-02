const { withAppBuildGradle, withMainApplication, withSettingsGradle } = require('@expo/config-plugins');

/**
 * 手工接入 `onnxruntime-react-native` 的原生模块（2026-10-02）。
 *
 * <p>**为什么不能靠自动链接**：在我们这套 RN 0.86 + Expo CNG 里，Expo 的自动链接**不认这个包**
 * （`npx expo-modules-autolinking react-native-config --platform android` 的输出里没有它，
 * 用 `app/react-native.config.js` 显式声明也没用）。结果是它的 Java 类**编进了 APK**
 * （`classes.dex` 里有 `ai/onnxruntime/reactnative`），但没人把它加进 `PackageList`，
 * 于是 `NativeModules.Onnxruntime` 是 **null**——而那个包在模块初始化时就要
 * `NativeModules.Onnxruntime.install()`，抛出的 `TypeError` 在 release 包里被 RN 当
 * **致命异常直接杀进程**（JS 侧 try/catch 救不回来）。
 *
 * <p>用户看到的就是两次闪退：0.0.2「一打开就闪退」（当时它在启动路径上）、
 * 0.0.5「点上传图片就闪退」（改成懒加载之后）。
 *
 * <p>所以这里手工做自动链接本该做、但没做的三件事：settings.gradle 引入工程、
 * app/build.gradle 依赖它、MainApplication 里 `add(OnnxruntimePackage())`。
 */
const MODULE_NAME = 'onnxruntime-react-native';
const PROJECT_DIR = `../node_modules/${MODULE_NAME}/android`;

module.exports = function withOnnxRuntime(config) {
  config = withSettingsGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(`:${MODULE_NAME}`)) {
      cfg.modResults.contents += [
        '',
        `// [withOnnxRuntime] Expo 自动链接漏了这个包，手工引入它的 Gradle 工程`,
        `include ':${MODULE_NAME}'`,
        `project(':${MODULE_NAME}').projectDir = new File(rootProject.projectDir, '${PROJECT_DIR}')`,
        '',
      ].join('\n');
    }
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(`project(':${MODULE_NAME}')`)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies\s*\{/,
        `dependencies {\n    // [withOnnxRuntime] 同上：自动链接漏了，手工加依赖\n    implementation project(':${MODULE_NAME}')`,
      );
    }
    return cfg;
  });

  config = withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;
    if (!contents.includes('ai.onnxruntime.reactnative')) {
      contents = contents.replace(
        /^(import expo\.modules\.ExpoReactHostFactory)$/m,
        '$1\nimport ai.onnxruntime.reactnative.OnnxruntimePackage',
      );
      // PackageList(this).packages.apply { ... } —— Kotlin 模板里预留的手工位
      contents = contents.replace(
        /PackageList\(this\)\.packages\.apply\s*\{/,
        'PackageList(this).packages.apply {\n          add(OnnxruntimePackage()) // [withOnnxRuntime] 手工注册',
      );
      cfg.modResults.contents = contents;
    }
    return cfg;
  });

  return config;
};
