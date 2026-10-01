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
