/**
 * React Native 自动链接的**显式声明**（2026-10-02 加）。
 *
 * <p>为什么需要它：`onnxruntime-react-native` 在我们这套（RN 0.86 + Expo CNG）里**没有被自动
 * 链接进 `PackageList`** —— 它的 Java 类确实编进了 APK（`classes.dex` 里有
 * `ai/onnxruntime/reactnative`），但 `NativeModules.Onnxruntime` 是 **null**，于是那个包在模块
 * 初始化时执行的 `NativeModules.Onnxruntime.install()` 直接抛
 * `TypeError: Cannot read property 'install' of null`；release 包里 RN 把它当**致命异常直接杀进程**
 * （JS 侧 `try/catch` 都救不回来，因为它是在模块加载阶段被上报的）。
 *
 * 症状就是用户报的：**0.0.2 一打开就闪退**（那时它在启动路径上）、后来变成
 * **点「上传图片」就闪退**（引擎改成懒加载之后）。
 *
 * <p>修法：把这个依赖的 android 配置显式写出来，让自动链接能生成对应条目。
 * 注意 `packageImportPath` / `packageInstance` 是**Java 代码片段**，不是路径。
 */
const path = require('path');

module.exports = {
  dependencies: {
    'onnxruntime-react-native': {
      platforms: {
        android: {
          sourceDir: path.join(__dirname, 'node_modules/onnxruntime-react-native/android'),
          packageImportPath: 'import ai.onnxruntime.reactnative.OnnxruntimePackage;',
          packageInstance: 'new OnnxruntimePackage()',
        },
      },
    },
  },
};
