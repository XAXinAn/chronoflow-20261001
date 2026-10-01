/**
 * Metro 配置（全仓只有这一份，且只在打包 / 启动 Metro 时读）。
 *
 * <p>存在的唯一理由：**把端侧 OCR 的 PaddleOCR 模型当资源打进包**。
 * 模型是 16MB 的二进制（`app/assets/models/ppocr/*.onnx` + 字典 `.txt`，都不进版本库，
 * 由 `scripts/fetch_ppocr_models.sh` 拉），代码里用 `import model from '...onnx'` 引用它们。
 *
 * <p>但 Metro 默认的 `assetExts` 里**没有** `onnx` 也没有 `txt`（那份清单只看图 / 音视频 /
 * 压缩包 / 字体）。不补这两项，`import` 会在**打包阶段**直接报 `Unable to resolve module`，
 * 连 APK 都出不来——不是运行时才炸。
 */
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

for (const extension of ['onnx', 'txt']) {
  if (!config.resolver.assetExts.includes(extension)) {
    config.resolver.assetExts.push(extension);
  }
}

module.exports = config;
