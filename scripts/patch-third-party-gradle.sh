#!/usr/bin/env bash
#
# 给第三方原生依赖的 build.gradle 打补丁。**每次构建前都要跑**（node_modules 会被重装覆盖），
# 由 `scripts/build_apk.sh` 自动调用。
#
# 为什么需要它：这台机器上出包用的是系统 Gradle 9.3.1（`~/.local` 那套便携工具链，
# 见 AGENTS §4.3：`./gradlew` 会被 prebuild 改坏）。而部分模块的 build.gradle 还按
# Gradle 7/8 的 API 写，配置阶段直接报错，**整个构建连一个 task 都跑不起来**。
#
# 补丁都写成幂等的（再跑一次不会重复改），并且**只在需要时改**，改动点都带注释说明原因。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODULES="$ROOT/app/node_modules"

# ---------------------------------------------------------------- onnxruntime
#
# `onnxruntime-react-native@1.24.3`（当前最新）的 android/build.gradle 里有：
#
#   if (VersionNumber.parse(REACT_NATIVE_VERSION) < VersionNumber.parse("0.71")) { ... }
#
# `org.gradle.util.VersionNumber` 在 Gradle 8 就被移出公开 API、9 里彻底没了，于是
# 配置阶段报 "Could not get unknown property 'VersionNumber'"，连带把 `:expo` 的
# release component 一起配置失败（第二个报错 "SoftwareComponent ... not found" 是它的连带反应，
# 不是 expo 的问题）。
#
# 这个分支只在 RN < 0.71 时才需要（给 fbjni 加依赖）。本项目是 RN 0.86.3，
# 分支本就不该进，所以直接把条件换成 `false` —— 比"抬 Gradle 版本"或"改模块 API"
# 都安全：不动依赖、不动 Gradle，只跳过一段不可能执行的代码。
ORT_GRADLE="$MODULES/onnxruntime-react-native/android/build.gradle"
if [ -f "$ORT_GRADLE" ]; then
  python3 - "$ORT_GRADLE" <<'PY'
import re, sys, pathlib

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
pattern = re.compile(
    r"if \(VersionNumber\.parse\(REACT_NATIVE_VERSION\) < VersionNumber\.parse\(\"0\.71\"\)\)"
)
if "[补丁] Gradle 9" in text:
    print("✓ onnxruntime-react-native：已经是打过补丁的状态")
    sys.exit(0)
patched = pattern.sub(
    "// [补丁] Gradle 9 里没有 VersionNumber；本项目 RN 0.86 ≥ 0.71，这个分支不需要\n  if (false)",
    text,
)
if patched == text:
    sys.stderr.write("⚠ onnxruntime-react-native：build.gradle 变了，补丁没匹配上，请人工看一眼\n")
    sys.exit(1)
path.write_text(patched, encoding="utf-8")
print("✓ onnxruntime-react-native：已跳过 VersionNumber 分支（Gradle 9 兼容）")
PY
fi
