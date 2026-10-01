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

# ------------------------------------------------- onnxruntime（16KB 页对齐）
#
# Android 15 起不少新机型的**页大小是 16KB**（模拟器也有 `ps16k` 镜像）。这类系统要求 APK 里
# 每个 `.so` 的 ELF **LOAD 段按 16KB 对齐**，否则加载直接失败——实测现象：
# **应用一启动就闪退**，系统还会弹一句
# 「This app isn't 16 KB compatible. LOAD segment alignment check failed …
#   libonnxruntimejsi.so : LOAD segment not aligned」。
#
# 本仓其它 `.so` 都是 `0x4000`（16KB）对齐的（连上游预编译的 `libreactnative.so`、`libonnxruntime.so`
# 都是），**只有 `libonnxruntimejsi.so` 是 `0x1000`**：它是本仓用 NDK 现编的（模块自带 CMakeLists），
# 而那个 CMake 工程没拿到 AGP 给自家 CMake 传的 16KB 参数。
#
# 所以给它补一行链接选项。**16KB 对齐的库在 4KB 页的老设备上照样能跑**（对齐大于页大小是安全的），
# 所以这条补丁不需要按机型分支。
ORT_CMAKE="$MODULES/onnxruntime-react-native/android/CMakeLists.txt"
if [ -f "$ORT_CMAKE" ]; then
  python3 - "$ORT_CMAKE" <<'PY'
import sys, pathlib

path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
marker = "APPEND_STRING PROPERTY LINK_FLAGS"
if marker in text:
    print("✓ onnxruntime-react-native：CMakeLists 已经是 16KB 对齐的状态")
    sys.exit(0)
anchor = "# Configure C++ 17"
if anchor not in text:
    sys.stderr.write("⚠ onnxruntime-react-native：CMakeLists 变了，16KB 补丁没匹配上，请人工看一眼\n")
    sys.exit(1)
patch = (
    "# [补丁] 16KB 页对齐：Android 15+ 的 16KB 页设备要求 .so 的 LOAD 段 ≥16KB，\n"
    "# 否则加载失败、应用启动即闪退（本仓其余 .so 都是 16KB）。\n"
    'set_property(TARGET onnxruntimejsi APPEND_STRING PROPERTY LINK_FLAGS " -Wl,-z,max-page-size=16384")\n\n'
)
path.write_text(text.replace(anchor, patch + anchor, 1), encoding="utf-8")
print("✓ onnxruntime-react-native：CMakeLists 已补 16KB 页对齐链接参数")
PY
fi
