#!/usr/bin/env bash
#
# 拉取端侧 OCR 要的 PaddleOCR（PP-OCRv4）模型。**出包之前必须跑过一次**，
# 因为模型是 16MB 的二进制，不进版本库（见 .gitignore）。
#
#   scripts/fetch_ppocr_models.sh          # 缺什么拉什么
#   scripts/fetch_ppocr_models.sh --force  # 全部重拉
#
# 为什么是 ONNX 而不是 Paddle-Lite 的 .nb：Paddle-Lite 的 Android AAR 没有发布到
# Maven（`com.baidu.paddle:paddle-lite` 在阿里云镜像是 404），要拿它只能去 GitHub release
# 淘；而 `com.microsoft.onnxruntime:onnxruntime-android` 在 Maven 上就有（镜像可达），
# 模型也能直接下现成的 ONNX —— 少一个「引擎从哪来」的不确定性。
#
# 三个模型与 PP-OCRv4 官方组合一致（det + rec 是 v4，cls 用的仍是 v2.0 那个，
# 这也是 RapidOCR 打包的组合）。字典是 rec 模型配套的那份（6622 行）。
#
# 来源：
#   模型  hf-mirror.com/SWHL/RapidOCR（RapidOCR 作者维护的 PP-OCR ONNX 转换版）
#   字典  hf-mirror.com/deepghs/paddleocr（与 rec 模型同一来源的配套字典）
#   两者都走 hf-mirror：GitHub 直连在本机不稳，raw 拉不动。
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/app/assets/models/ppocr"
MODELS_BASE="https://hf-mirror.com/SWHL/RapidOCR/resolve/main"
DICT_URL="https://hf-mirror.com/deepghs/paddleocr/resolve/main/rec/ch_PP-OCRv4_rec/dict.txt"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
  esac
done

mkdir -p "$DEST"

# 文件名 → 最小体积（字节）。体积是「下没下全」最直接的判据：hf-mirror 偶尔会回一个
# 几百字节的错误页，只看「文件存在」会拿到一个假模型，直到推理时才炸。
fetch() {
  local url="$1" name="$2" min_bytes="$3"
  local path="$DEST/$name"
  if [ "$FORCE" = "0" ] && [ -f "$path" ]; then
    local size
    size=$(stat -c %s "$path")
    if [ "$size" -ge "$min_bytes" ]; then
      echo "✓ $name 已存在（$size 字节）"
      return
    fi
    echo "… $name 只有 $size 字节，太小，重下"
  fi
  echo "↓ $name"
  curl -fL --retry 3 -m 600 -o "$path" "$url"
  local size
  size=$(stat -c %s "$path")
  if [ "$size" -lt "$min_bytes" ]; then
    echo "✗ $name 只有 $size 字节（期望 ≥ $min_bytes），下载源可能返回了错误页" >&2
    rm -f "$path"
    exit 1
  fi
}

fetch "$MODELS_BASE/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx" ch_PP-OCRv4_det_infer.onnx 4000000
fetch "$MODELS_BASE/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx" ch_PP-OCRv4_rec_infer.onnx 9000000
fetch "$MODELS_BASE/PP-OCRv1/ch_ppocr_mobile_v2.0_cls_infer.onnx" ch_ppocr_mobile_v2.0_cls_infer.onnx 400000
fetch "$DICT_URL" ppocr_keys_v1.txt 20000

echo
echo "模型就位：$DEST"
ls -la "$DEST"
