#!/usr/bin/env bash
#
# 发布一个 Android 安装包到演示服务器，并打印要写进 /opt/chronoflow/.env 的配置
# （spec §4.1.11「应用内更新」）。
#
# 用法：
#   scripts/publish_apk.sh <apk 路径> <版本名> <版本号> [更新说明] [--force]
#
#   例：scripts/publish_apk.sh app/android/app/build/outputs/apk/release/app-release.apk \
#          0.2.0 2 "图片识别日程|草稿可编辑" --force
#
# 它做三件事：
#   1. 把包装成 app-<版本名>.apk 传到 /opt/chronoflow/web/downloads/（nginx 的 /downloads/ 直接发）；
#   2. 算出字节数与 SHA-256；
#   3. 打印「贴进 .env 就行」的那几行 —— 剩下一步是 `docker-compose up -d backend`。
#
# 为什么不让脚本直接改 .env：那台机器上 .env 是唯一的事实来源（含真 Key），
# 让一个发布脚本去编辑它，出问题的代价比「多贴四行」大得多。

set -euo pipefail

SSH_KEY="${CHRONOFLOW_DEPLOY_KEY:-$HOME/develop/workspace/XAXINAN.pem}"
SSH_HOST="${CHRONOFLOW_DEPLOY_HOST:-root@8.136.20.182}"
REMOTE_DIR="/opt/chronoflow/web/downloads"
PUBLIC_BASE="${CHRONOFLOW_PUBLIC_BASE:-http://8.136.20.182:8088}"

APK="${1:-}"
VERSION_NAME="${2:-}"
VERSION_CODE="${3:-}"
CHANGELOG="${4:-}"
FORCE="false"
for arg in "$@"; do
  [ "$arg" = "--force" ] && FORCE="true"
done

if [ -z "$APK" ] || [ -z "$VERSION_NAME" ] || [ -z "$VERSION_CODE" ]; then
  sed -n '2,20p' "$0"
  exit 2
fi
[ -f "$APK" ] || { echo "找不到安装包：$APK" >&2; exit 1; }
case "$VERSION_CODE" in (*[!0-9]*) echo "版本号必须是整数：$VERSION_CODE" >&2; exit 2;; esac

FILE_NAME="app-${VERSION_NAME}.apk"
SIZE_BYTES=$(stat -c%s "$APK")
SHA256=$(sha256sum "$APK" | awk '{print $1}')

echo "→ 上传 $(basename "$APK") → $SSH_HOST:$REMOTE_DIR/$FILE_NAME（$((SIZE_BYTES / 1024 / 1024)) MB）"
ssh -i "$SSH_KEY" "$SSH_HOST" "mkdir -p $REMOTE_DIR"
scp -i "$SSH_KEY" "$APK" "$SSH_HOST:$REMOTE_DIR/$FILE_NAME"

cat <<EOF

✅ 包已就位：$PUBLIC_BASE/downloads/$FILE_NAME

把这九行贴进服务器 /opt/chronoflow/.env（版本号必须比线上 APK 大，否则没人更新）：

CHRONOFLOW_APP_RELEASE_VERSION_NAME=$VERSION_NAME
CHRONOFLOW_APP_RELEASE_VERSION_CODE=$VERSION_CODE
CHRONOFLOW_APP_RELEASE_APK_URL=/downloads/$FILE_NAME
CHRONOFLOW_APP_RELEASE_SIZE_BYTES=$SIZE_BYTES
CHRONOFLOW_APP_RELEASE_SHA256=$SHA256
CHRONOFLOW_APP_RELEASE_CHANGELOG=$CHANGELOG
CHRONOFLOW_APP_RELEASE_FORCE=$FORCE
CHRONOFLOW_APP_RELEASE_MIN_SUPPORTED_VERSION_CODE=0
CHRONOFLOW_APP_RELEASE_PUBLISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

然后（compose 里已经透传了这些变量，只重启后端即可）：
  ssh -i $SSH_KEY $SSH_HOST 'cd /opt/chronoflow && docker-compose up -d backend'

自检：
  curl -s $PUBLIC_BASE/api/v1/system/app-release
EOF
