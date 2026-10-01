#!/usr/bin/env bash
#
# 出一版 Android debug APK —— 把这台机器上**踩过的坑**全部固化下来。
#
# 为什么要有这个脚本：`expo prebuild` 会**重新生成** `app/android/gradle.properties`，
# 把我们写在 `~/.gradle/gradle.properties` 里的内存保护（workers.max / parallel=false）
# 全部覆盖掉。结果是原生编译（CMake + ninja + 几十个 clang++）瞬间吃掉几个 GB，
# 在 7.4GB 的 WSL 里触发内核 OOM killer —— 2026-10-01 就这么崩过两次：
#
#   kernel: Out of memory: Killed process 1571 (java) total-vm:13500628kB, anon-rss:2243952kB
#   （同一时刻还有二十多个 clang++ 在跑）
#
# 崩掉的后果不只是构建失败：整个 WSL 虚拟机被重启，跑在里面的一切（Metro、agent 会话）
# 一起没了，终端还留在鼠标追踪模式，于是鼠标一动就往屏幕上刷 `35;61;18M…`。
#
# 用法：
#   scripts/build_apk.sh                        # debug 包（给模拟器用，需要 Metro）
#   scripts/build_apk.sh --prebuild             # 先 expo prebuild --clean 再编译（改了 app.json 时用）
#   scripts/build_apk.sh --release --archs=arm64-v8a,x86_64
#                                               # 独立可用的包（JS 打进包里，装到手机就能跑）
#
# 编译完会**顺手复制一份到 Windows 桌面**（`/mnt/c/Users/jiang/Desktop/时纪流-<版本>(<versionCode>)-<debug|release>.apk`），
# 联调时从桌面拖进模拟器/手机最省事；换目录用 `CHRONOFLOW_DESKTOP_DIR=...`。
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
ANDROID="$APP/android"
GRADLE_HOME_DIR="${CHRONOFLOW_GRADLE_HOME:-/home/jiang/tools/gradle-9.3.1/gradle-9.3.1}"
export JAVA_HOME="${JAVA_HOME:-/home/jiang/tools/jdk-17}"
export ANDROID_HOME="${ANDROID_HOME:-/home/jiang/tools/android-sdk}"

# 关键：把 CMake/ninja 的并行度压到 2。AGP 里 Gradle worker 数管不到 ninja 内部的 -j，
# 而这个环境变量是 CMake 官方认的（`cmake --build` 会照它设 ninja 的并行度）。
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-2}"

BUILD_TYPE="debug"
ARCHS="${CHRONOFLOW_ARCHS:-x86_64}"
for arg in "$@"; do
  case "$arg" in
    --prebuild) PREBUILD=1 ;;
    --release) BUILD_TYPE="release" ;;
    --debug) BUILD_TYPE="debug" ;;
    --archs=*) ARCHS="${arg#--archs=}" ;;
  esac
done

if [ "${PREBUILD:-0}" = "1" ]; then
  echo "→ expo prebuild --platform android --clean"
  (cd "$APP" && npx expo prebuild --platform android --clean)
fi

[ -d "$ANDROID" ] || { echo "没有 $ANDROID：先跑 scripts/build_apk.sh --prebuild" >&2; exit 1; }

# prebuild 会把这两个又要紧又容易被覆盖的配置改回去，每次构建前重新钉一遍
echo "→ 固定 gradle 配置（ABI=$ARCHS + 压低内存/并行）"
python3 - "$ANDROID/gradle.properties" "$ARCHS" <<'PY'
import re, sys, pathlib
path = pathlib.Path(sys.argv[1])
archs = sys.argv[2]
text = path.read_text(encoding="utf-8")
wanted = {
    # 4 个 ABI 会让原生库合并慢到离谱（实测 28 分钟还没完）。
    # 模拟器用 x86_64，真机要 arm64-v8a；要给别人的安装包就两个都带上（通用包）。
    "reactNativeArchitectures": archs,
    "org.gradle.jvmargs": "-Xmx2048m -XX:MaxMetaspaceSize=512m",
    "org.gradle.parallel": "false",
    "org.gradle.workers.max": "2",
    "org.gradle.daemon": "false",
    "org.gradle.caching": "true",
}
lines = text.splitlines()
seen = set()
for index, line in enumerate(lines):
    match = re.match(r"^([A-Za-z0-9_.]+)=", line)
    if match and match.group(1) in wanted:
        key = match.group(1)
        lines[index] = f"{key}={wanted[key]}"
        seen.add(key)
for key, value in wanted.items():
    if key not in seen:
        lines.append(f"{key}={value}")
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY

# 某些第三方原生模块的 build.gradle 比这台机器上的 Gradle 9 还老（见脚本里的注释）。
# 每次构建前重新打一遍补丁：node_modules 会被 npm 重装覆盖，补丁不能只打一次。
bash "$ROOT/scripts/patch-third-party-gradle.sh"

# 端侧 OCR 的 PaddleOCR 模型（16MB）不进版本库（见 .gitignore 与 fetch_ppocr_models.sh）。
# 缺了它们，Metro 会在打包阶段报 `Unable to resolve module ...onnx`，看着像代码问题。
# 这个脚本是幂等的：文件齐了只做体积校验（不联网），缺了才下载。
echo "→ 确认端侧 OCR 模型（PaddleOCR PP-OCRv4）"
bash "$ROOT/scripts/fetch_ppocr_models.sh"

# app.json 里的版本号要**钉进 build.gradle**：`android/` 是 `expo prebuild` 生成后就不再跟着
# app.json 变的（CNG 只在你显式 prebuild 时重写）。2026-10-01 就踩过这一条：app.json 改成
# 0.0.2/3，包名也叫 chronoflow-0.0.2.apk，**包里的 versionCode 还是 2、versionName 还是 0.0.1**
# → 手机装上后「还是提示有新版本」，无限弹更新。这里每次构建前对齐一次，杜绝再犯。
echo "→ 把 app.json 的版本钉进 android/app/build.gradle"
python3 - "$ANDROID/app/build.gradle" "$APP/app.json" <<'PY'
import json, re, sys, pathlib

gradle = pathlib.Path(sys.argv[1])
config = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))["expo"]
version_name = config["version"]
version_code = int(config["android"]["versionCode"])
text = gradle.read_text(encoding="utf-8")
patched, count_code = re.subn(r"\bversionCode\s+\d+", f"versionCode {version_code}", text, count=1)
patched, count_name = re.subn(r'\bversionName\s+"[^"]*"', f'versionName "{version_name}"', patched, count=1)
if not count_code or not count_name:
    sys.stderr.write("⚠ 没在 build.gradle 里找到 versionCode / versionName，请人工看一眼\n")
    sys.exit(1)
gradle.write_text(patched, encoding="utf-8")
print(f"  versionName={version_name} versionCode={version_code}")
PY

if [ "$BUILD_TYPE" = "release" ]; then
  TASK=":app:assembleRelease"
  OUT="$ANDROID/app/build/outputs/apk/release/app-release.apk"
else
  TASK=":app:assembleDebug"
  OUT="$ANDROID/app/build/outputs/apk/debug/app-debug.apk"
fi

echo "→ 编译 $BUILD_TYPE APK（workers=2, ninja=$CMAKE_BUILD_PARALLEL_LEVEL, ABI=$ARCHS）"
(cd "$ANDROID" && "$GRADLE_HOME_DIR/bin/gradle" "$TASK" \
  --no-daemon --max-workers=2 --console=plain)

[ -f "$OUT" ] || { echo "编译结束但没找到 APK" >&2; exit 1; }
echo
echo "✅ $OUT"
ls -lh "$OUT"

# 16KB 页对齐检查（Android 15+ 的 16KB 页机型**必须**满足，否则一启动就闪退）。
# 见 `scripts/patch-third-party-gradle.sh` 里 onnxruntime 那段：libonnxruntimejsi.so 曾经是
# 0x1000，整台手机上的 App 直接打不开，而模拟器/老机型看不出问题——所以这里**构建期硬卡**。
# 本机没有 unzip/readelf，用纯 python 解 zip + 读 ELF program header，任何机器都能跑。
echo "→ 检查包内 .so 的 16KB 页对齐"
python3 - "$OUT" <<'PY'
import struct, sys, zipfile

path = sys.argv[1]
bad = []
checked = 0
with zipfile.ZipFile(path) as apk:
    for name in apk.namelist():
        if not (name.startswith("lib/") and name.endswith(".so")):
            continue
        data = apk.read(name)
        if data[:4] != b"\x7fELF":
            continue
        is64 = data[4] == 2
        if is64:
            phoff, phentsize, phnum = struct.unpack_from("<QHH", data, 32)
        else:
            phoff, phentsize, phnum = struct.unpack_from("<IHH", data, 28)
        aligns = []
        for index in range(phnum):
            base = phoff + index * phentsize
            if is64:
                p_type = struct.unpack_from("<I", data, base)[0]
                p_align = struct.unpack_from("<Q", data, base + 48)[0]
            else:
                p_type = struct.unpack_from("<I", data, base)[0]
                p_align = struct.unpack_from("<I", data, base + 28)[0]
            if p_type == 1:  # PT_LOAD
                aligns.append(p_align)
        checked += 1
        if any(align < 0x4000 for align in aligns):
            bad.append((name, [hex(align) for align in aligns]))

print(f"  检查了 {checked} 个 .so")
if bad:
    sys.stderr.write("✗ 这些库的 LOAD 段不是 16KB 对齐（Android 15+ 的 16KB 页机型上会加载失败、启动闪退）：\n")
    for name, aligns in bad:
        sys.stderr.write(f"    {name} → {', '.join(aligns)}\n")
    sys.stderr.write("  修法见 scripts/patch-third-party-gradle.sh（给对应模块补 -Wl,-z,max-page-size=16384）\n")
    sys.exit(1)
print("  ✓ 全部 16KB 对齐")
PY

# 顺手放一份到 Windows 桌面（WSL 路径 /mnt/c/...）。联调时从桌面拖进模拟器/手机最省事。
# 文件名带版本号与构建类型，桌面上堆多个包时一眼能分辨是哪个。
DESKTOP_DIR="${CHRONOFLOW_DESKTOP_DIR:-/mnt/c/Users/jiang/Desktop}"
if [ -d "$DESKTOP_DIR" ]; then
  VERSION_NAME=$(python3 -c "import json;print(json.load(open('$APP/app.json'))['expo']['version'])")
  VERSION_CODE=$(python3 -c "import json;print(json.load(open('$APP/app.json'))['expo']['android']['versionCode'])")
  # 命名与线上发布保持一致：chronoflow-<版本名>.apk（debug 包多带一个后缀区分）。
  # 以前叫「时纪流-0.0.0(1)-release.apk」：括号里是 versionCode，容易被误认成
  # 系统自动去重加的「 (1)」，而且和下载链接里的名字对不上。
  # 注意别写成 `$( [ ... ] && echo ... )`：条件不成立时那个子命令返回 1，
  # 赋值语句会把它当自己的退出码，配合 `set -e` 会让脚本**静默退出**（踩过）。
  if [ "$BUILD_TYPE" = debug ]; then
    DESKTOP_APK="$DESKTOP_DIR/chronoflow-${VERSION_NAME}-debug.apk"
  else
    DESKTOP_APK="$DESKTOP_DIR/chronoflow-${VERSION_NAME}.apk"
  fi
  if cp -f "$OUT" "$DESKTOP_APK"; then
    echo "📋 已复制到桌面：$DESKTOP_APK"
  else
    echo "⚠️ 复制到桌面失败（$DESKTOP_APK），APK 仍在 $OUT" >&2
  fi
else
  echo "（桌面目录 $DESKTOP_DIR 不存在，跳过复制；可用 CHRONOFLOW_DESKTOP_DIR 指定）"
fi
