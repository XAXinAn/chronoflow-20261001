#!/usr/bin/env bash
# 验证一个高德 Key 是否可用，并给出接入本项目的下一步。
#
# 用法：
#   scripts/check_amap_key.sh <你的Key>
#   GEO_AMAP_KEY=<你的Key> scripts/check_amap_key.sh
#
# 说明：这里直连高德 REST 接口，用来把「Key 本身有问题」和
# 「项目配置有问题」区分开。两类问题的表现都是搜不到地点，混在一起排查很费时间。

set -u

KEY="${1:-${GEO_AMAP_KEY:-}}"

if [ -z "$KEY" ]; then
  echo "用法: $0 <你的高德Key>   （或设置 GEO_AMAP_KEY 环境变量）" >&2
  exit 2
fi

# 只回显头尾，避免把完整 Key 贴到日志或聊天记录里
echo "待验证 Key: ${KEY:0:6}…${KEY: -4}（长度 ${#KEY}）"
echo

probe() {
  local label="$1" url="$2"
  echo "=== $label ==="
  local body
  body="$(curl -s -m 10 "$url")" || {
    echo "请求失败（网络不通？）"
    return 1
  }
  # 这里必须显式接住退出码：函数最后一句是 echo，会把 python 的失败状态吞掉，
  # 结果就是 Key 无效也报「通过」——这种假阳性比不检查还糟。
  local py_rc=0
  python3 - "$body" <<'PY'
import json, sys
raw = sys.argv[1]
try:
    data = json.loads(raw)
except Exception:
    print("返回内容不是 JSON：", raw[:200])
    raise SystemExit(1)
status = data.get("status")
info = data.get("info")
print(f"  status = {status}  info = {info}  infocode = {data.get('infocode')}")
if status != "1":
    raise SystemExit(1)
if "pois" in data:
    pois = data.get("pois") or []
    print(f"  命中 {len(pois)} 条，前 3 条：")
    for poi in pois[:3]:
        print(f"    - {poi.get('name')} | {poi.get('address')} | {poi.get('location')}")
else:
    regeo = data.get("regeocode", {})
    print(f"  地址: {regeo.get('formatted_address')}")
    comp = regeo.get("addressComponent", {})
    print(f"  省市: {comp.get('province')}/{comp.get('city')}/{comp.get('district')}")
PY
  py_rc=$?
  echo
  return "$py_rc"
}

rc=0
probe "1) 关键字搜索 /v3/place/text（北京南站）" \
  "https://restapi.amap.com/v3/place/text?key=${KEY}&keywords=%E5%8C%97%E4%BA%AC%E5%8D%97%E7%AB%99&city=%E5%8C%97%E4%BA%AC&offset=3&page=1&extensions=base" || rc=1

probe "2) 逆地理编码 /v3/geocode/regeo（国贸坐标）" \
  "https://restapi.amap.com/v3/geocode/regeo?key=${KEY}&location=116.4571,39.9088&extensions=base" || rc=1

if [ "$rc" -ne 0 ]; then
  cat <<'EOF'
上面有一步没通过。按 info 字段对照：
  INVALID_USER_KEY    Key 拼错，或服务平台选成了「Web端(JS API)」而不是「Web服务」
  USER_DAILY_QUERY_OVER_LIMIT  当日免费额度用尽（换个 Key 或次日再试）
  INVALID_USER_IP     配了 IP 白名单，但当前出口 IP 不在名单里
  SERVICE_NOT_AVAILABLE  该服务未开通（控制台里确认已勾选「Web服务」）
EOF
  exit 1
fi

echo "两步都通过，这个 Key 可以直接接进项目："
echo
echo "  cd /home/jiang/develop/xa-todo/backend-java/chronoflow-bootstrap"
echo "  GEO_AMAP_KEY=${KEY:0:6}… setsid nohup /home/jiang/tools/jdk-21.0.12.1+1/bin/java \\"
echo "      -jar target/chronoflow-bootstrap-0.1.0-SNAPSHOT.jar > /tmp/cf-backend.log 2>&1 < /dev/null & disown"
echo
echo "然后确认已切到真实高德（degraded 应为 false）："
echo "  curl -s -H 'Authorization: Bearer <accessToken>' http://localhost:8080/api/v1/geo/config"
