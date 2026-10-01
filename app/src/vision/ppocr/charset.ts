/**
 * 识别头的**字符表**——CTC 解码要把「第 i 类」翻译成汉字，靠的就是它。
 *
 * <p>两类最容易错的地方，这里一次说清：
 *
 * <p><b>1. 下标 0 是 blank，最后一个类别是空格。</b> PP-OCR 的 rec 模型输出 6625 类，
 * 而字典文件只有 6623 行——差的两位不是笔误，是官方那套 `['blank'] + 字典 + [' ']`
 * （`use_space_char=True`）。少补一个，整行文字会**整体错位一位**：识别结果看起来
 * 全是不相干的字，而不是直接报错。
 *
 * <p><b>2. 字典顺序必须和模型一致。</b> 模型的 ONNX 元数据里带一个 `character` 字段，
 * 理论上该以它为准；但 `onnxruntime-react-native`（1.24.3）**没有暴露 model metadata 的接口**
 * （只有输入 / 输出的形状），运行时读不到。所以离线核对过：本仓拉下来的
 * `ppocr_keys_v1.txt` 与模型元数据里的 `character` **逐条相同**（6623 条，比对脚本见
 * AGENTS §0.0 第十九轮）。{@link buildCharacterList} 仍然会拿模型的类别数
 * **交叉校验**一遍，对不上就当场抛错——宁可识别不可用，也不要悄悄错位。
 */

/** 官方 rec 模型的类别数（`1 blank + 6623 字典字 + 1 空格`），只用于给错误信息一个参照。 */
export const REC_CLASSES = 6625;

/**
 * 字典文本（换行分隔）→ 字符表（下标 0 是 blank，末尾是空格）。
 *
 * @param dictText 字典文件内容，一行一个字
 * @param classes 模型输出的类别数（来自 ONNX 输出的最后一维）；给了就校验
 */
export function buildCharacterList(dictText: string, classes?: number): string[] {
  const characters = dictText
    .split('\n')
    // 只去掉换行符：PaddleOCR 的字典是按行 `.strip("\n").strip("\r\n")` 读的，
    // 用 `trim()` 会把某些字（比如全角空格类的符号）一起吃掉
    .map((line) => line.replace(/[\r\n]+$/, ''))
    .filter((line) => line.length > 0);

  if (characters.length === 0) {
    throw new Error('字符表是空的：字典文件没读到内容');
  }

  const list = ['', ...characters];
  if (classes === undefined) {
    // 没给类别数（单测、离线脚本）时按官方约定补空格
    return [...list, ' '];
  }
  if (classes === list.length) {
    // 少数转换版会把空格写进元数据里，那就不补
    return list;
  }
  if (classes === list.length + 1) {
    return [...list, ' '];
  }
  throw new Error(
    `字符表与模型对不上：字典 ${characters.length} 字（+blank 共 ${list.length} 类），模型输出 ${classes} 类`,
  );
}
