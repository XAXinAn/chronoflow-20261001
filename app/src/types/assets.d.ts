/**
 * 非 JS 资源（模型、字典）的模块声明。
 *
 * <p>Metro 把它们当**资源**打包（`app/metro.config.js` 里给 `assetExts` 补了 onnx / txt），
 * `import` 回来的是一个**资源 id（number）**，要交给 `expo-asset` 的 `Asset.fromModule`
 * 去解析成本地文件路径。TS 不知道这回事，所以在这里声明一下。
 */
declare module '*.onnx' {
  const assetId: number;
  export default assetId;
}

declare module '*.txt' {
  const assetId: number;
  export default assetId;
}
