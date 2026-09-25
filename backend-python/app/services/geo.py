"""地点与地图（spec §5.9）。

与 Java 版行为完全对齐：同一套降级规则、同一份内置地点集、同样的错误语义。
Key 只留在服务端——App 调本服务的 /geo/*，由服务端再调第三方。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from ..config import settings
from ..errors import ApiError, ErrorCode

AMAP = "amap"
LOCAL = "local"
DEFAULT_LIMIT = 20
MAX_LIMIT = 50


def _place(poi_id, name, address, lat, lng, city, district, provider=LOCAL):
    return {
        "poiId": poi_id,
        "name": name,
        "address": address,
        "latitude": float(lat),
        "longitude": float(lng),
        "city": city,
        "district": district,
        "provider": provider,
    }


# 内置地点集：规模刻意很小，价值不在「够用」，而在让整条链路在离线环境仍可验证
_LOCAL_PLACES = [
    _place("BJ-TAM", "天安门广场", "北京市东城区东长安街", 39.9087, 116.3975, "北京市", "东城区"),
    _place("BJ-NAN", "北京南站", "北京市丰台区永外大街车站路12号", 39.8654, 116.3787, "北京市", "丰台区"),
    _place("BJ-T3", "首都机场T3航站楼", "北京市顺义区机场东路", 40.0553, 116.6151, "北京市", "顺义区"),
    _place("BJ-ZGC", "中关村软件园", "北京市海淀区东北旺西路8号", 40.046, 116.287, "北京市", "海淀区"),
    _place("BJ-GM", "国贸三期", "北京市朝阳区建国门外大街1号", 39.9088, 116.457, "北京市", "朝阳区"),
    _place("BJ-WJ", "望京SOHO", "北京市朝阳区望京街10号", 39.996, 116.481, "北京市", "朝阳区"),
    _place("SH-BUND", "外滩", "上海市黄浦区中山东一路", 31.24, 121.49, "上海市", "黄浦区"),
    _place("SH-HQ", "上海虹桥站", "上海市闵行区申贵路1500号", 31.195, 121.32, "上海市", "闵行区"),
    _place("SH-LJZ", "陆家嘴", "上海市浦东新区陆家嘴环路", 31.24, 121.505, "上海市", "浦东新区"),
    _place("SH-ZJ", "张江高科", "上海市浦东新区春晓路289号", 31.205, 121.59, "上海市", "浦东新区"),
    _place("SZ-NORTH", "深圳北站", "深圳市龙华区民治街道", 22.61, 114.029, "深圳市", "龙华区"),
    _place("SZ-TX", "腾讯滨海大厦", "深圳市南山区科技园南区", 22.523, 113.935, "深圳市", "南山区"),
    _place("SZ-BAY", "深圳湾科技生态园", "深圳市南山区白石路3609号", 22.529, 113.948, "深圳市", "南山区"),
    _place("HZ-XH", "西湖", "杭州市西湖区龙井路1号", 30.245, 120.14, "杭州市", "西湖区"),
    _place("HZ-ALI", "阿里巴巴西溪园区", "杭州市余杭区文一西路969号", 30.279, 120.026, "杭州市", "余杭区"),
    _place("GZ-TOWER", "广州塔", "广州市海珠区阅江西路222号", 23.106, 113.325, "广州市", "海珠区"),
    _place("GZ-SOUTH", "广州南站", "广州市番禺区石壁街道", 22.989, 113.269, "广州市", "番禺区"),
]


def _squared_distance(lat, lng, place):
    d_lat = float(lat) - place["latitude"]
    # 粗略的经纬度比例，够用来挑「最近的那个」
    d_lng = (float(lng) - place["longitude"]) * 0.78
    return d_lat * d_lat + d_lng * d_lng


class LocalGeoProvider:
    name = LOCAL

    def search_places(self, keyword, city, lat, lng, limit):
        if not keyword:
            return []
        needle = keyword.strip().lower()
        matched = [
            item
            for item in _LOCAL_PLACES
            if (needle in item["name"].lower() or needle in item["address"].lower())
            and (not city or (item["city"] and city.strip() in item["city"]))
        ]
        if lat is not None and lng is not None:
            matched.sort(key=lambda item: _squared_distance(lat, lng, item))
        else:
            matched.sort(key=lambda item: item["name"])
        return matched[: max(1, limit)]

    def reverse_geocode(self, lat, lng):
        nearest = min(_LOCAL_PLACES, key=lambda item: _squared_distance(lat, lng, item))
        # 内置集合覆盖有限，附近没有已知地点时如实告知，不假装知道这是哪儿
        if _squared_distance(lat, lng, nearest) >= 0.25:
            return _place(None, "自定义地点", None, lat, lng, None, None)
        return nearest


class AmapGeoProvider:
    name = AMAP

    def _get(self, path, params):
        query = urllib.parse.urlencode({**params, "key": settings.amap_key})
        url = f"{settings.amap_base_url}{path}?{query}"
        try:
            with urllib.request.urlopen(url, timeout=settings.amap_timeout) as response:
                body = response.read().decode("utf-8")
        except (urllib.error.URLError, TimeoutError, OSError) as cause:
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "地点服务不可达") from cause
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as cause:
            raise ApiError(ErrorCode.THIRD_PARTY_UNAVAILABLE, "地点服务返回内容无法解析") from cause
        if str(payload.get("status")) != "1":
            # 把 info 带出去：Key 无效 / 配额用尽 / 参数错误 的排查全靠它
            raise ApiError(
                ErrorCode.THIRD_PARTY_UNAVAILABLE,
                f"地点服务调用失败: {payload.get('info', '未知原因')}",
            )
        return payload

    @staticmethod
    def _parse_location(value):
        if not value or "," not in value:
            return None
        lng, lat = value.split(",", 1)
        try:
            return float(lng), float(lat)
        except ValueError:
            return None

    def search_places(self, keyword, city, lat, lng, limit):
        if not keyword:
            return []
        params = {
            "keywords": keyword,
            "offset": min(max(limit, 1), 25),
            "page": 1,
            "extensions": "base",
        }
        if city:
            params["city"] = city
        if lat is not None and lng is not None:
            # 高德的 location 是「经度,纬度」，与常见写法相反，别写反
            params["location"] = f"{lng},{lat}"
        payload = self._get("/v3/place/text", params)

        places = []
        for poi in payload.get("pois") or []:
            coordinate = self._parse_location(poi.get("location"))
            if coordinate is None:
                continue
            poi_lng, poi_lat = coordinate
            places.append(
                _place(
                    poi.get("id") or None,
                    poi.get("name"),
                    poi.get("address") or None,
                    poi_lat,
                    poi_lng,
                    poi.get("cityname") or None,
                    poi.get("adname") or None,
                    AMAP,
                )
            )
        return places

    def reverse_geocode(self, lat, lng):
        payload = self._get("/v3/geocode/regeo", {"location": f"{lng},{lat}", "extensions": "base"})
        regeocode = payload.get("regeocode") or {}
        address = regeocode.get("formatted_address") or None
        component = regeocode.get("addressComponent") or {}
        # 高德对直辖市返回空 city，此时用 province 兜底
        city = component.get("city") or component.get("province") or None
        district = component.get("district") or None

        pois = regeocode.get("pois") or []
        if pois:
            first = pois[0]
            return _place(first.get("id") or None, first.get("name"), address, lat, lng, city, district, AMAP)
        return _place(None, address or "当前位置", address, lat, lng, city, district, AMAP)


class GeoService:
    """把「用哪个服务商」收敛到一处；降级必须对客户端可见（spec §5.9）。"""

    def __init__(self):
        configured = (settings.geo_provider or LOCAL).strip().lower()
        self.configured_provider = configured
        if configured == AMAP and settings.amap_key.strip():
            self._provider = AmapGeoProvider()
            self._degraded_reason = None
        else:
            self._provider = LocalGeoProvider()
            self._degraded_reason = "未配置高德 Key，已降级为内置地点集" if configured == AMAP else None

    @property
    def provider_name(self):
        return self._provider.name

    @property
    def degraded(self):
        return self._degraded_reason is not None

    @property
    def degraded_reason(self):
        return self._degraded_reason

    @property
    def js_key(self):
        """可空：未配置时 App 隐藏「地图选点」，退回列表搜索。"""
        return settings.amap_js_key.strip() or None

    @property
    def js_security_code(self):
        return settings.amap_js_security_code.strip() or None

    def search_places(self, keyword, city, lat, lng, limit):
        if not keyword or not keyword.strip():
            raise ApiError(ErrorCode.PARAM_MISSING, "keyword 不能为空")
        _require_range(lat, lng)
        size = DEFAULT_LIMIT if limit is None else min(max(int(limit), 1), MAX_LIMIT)
        return self._provider.search_places(keyword.strip(), city, lat, lng, size)

    def reverse_geocode(self, lat, lng):
        if lat is None or lng is None:
            raise ApiError(ErrorCode.PARAM_MISSING, "lat 与 lng 不能为空")
        _require_range(lat, lng)
        return self._provider.reverse_geocode(lat, lng)


def _require_range(lat, lng):
    if lat is None or lng is None:
        return
    if not -90 <= float(lat) <= 90 or not -180 <= float(lng) <= 180:
        raise ApiError(ErrorCode.PARAM_INVALID, "经纬度超出有效范围")
