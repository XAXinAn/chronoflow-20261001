"""地点与地图接口（spec §6.2「地点与地图」分组）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response

from ..deps import current_identity
from ..errors import envelope
from ..security import IdentityPrincipal
from ..services.geo import GeoService

router = APIRouter(prefix="/api/v1", tags=["geo"])
# 地图选点页不在 /api/v1 下：它是给 WebView 直接加载的 HTML 页面，不是 JSON 接口
page_router = APIRouter(tags=["geo"])

_service = GeoService()


def get_geo_service() -> GeoService:
    return _service


@router.get("/geo/places")
def places(
    keyword: str = Query(...),
    city: str | None = Query(default=None),
    lat: float | None = Query(default=None),
    lng: float | None = Query(default=None),
    limit: int | None = Query(default=None),
    principal: IdentityPrincipal = Depends(current_identity),
    service: GeoService = Depends(get_geo_service),
) -> dict:
    return envelope(service.search_places(keyword, city, lat, lng, limit))


@router.get("/geo/regeo")
def regeo(
    lat: float = Query(...),
    lng: float = Query(...),
    principal: IdentityPrincipal = Depends(current_identity),
    service: GeoService = Depends(get_geo_service),
) -> dict:
    return envelope(service.reverse_geocode(lat, lng))


@router.get("/geo/config")
def config(
    principal: IdentityPrincipal = Depends(current_identity),
    service: GeoService = Depends(get_geo_service),
) -> dict:
    return envelope(
        {
            "provider": service.provider_name,
            "configuredProvider": service.configured_provider,
            "degraded": service.degraded,
            "degradedReason": service.degraded_reason,
            # 只在服务端配了 JS Key 时下发；App 据此决定是否展示「地图选点」
            "jsApiKey": service.js_key,
            "jsSecurityCode": service.js_security_code,
        }
    )


_MAP_PAGE_TEMPLATE = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <style>
    html,body,#map{height:100%;margin:0;padding:0;background:#f2f2f2}
    #hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
          font:14px -apple-system,sans-serif;color:#6B6B6B}
  </style>
  <script>__SECURITY__</script>
  <script>
    window.onerror = function (msg) {
      report({ type: 'error', message: '地图脚本执行异常: ' + msg });
      return false;
    };
  </script>
</head>
<body>
  <div id="map"></div>
  <div id="hint">正在定位…</div>
  <script>
    var map = null;
    function report(payload) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
    // 地图只在拿到第一个定位/选点之后才创建，避免闪一下默认地点
    function ensureMap(lng, lat) {
      if (map) { return; }
      var hint = document.getElementById('hint');
      if (hint) { hint.style.display = 'none'; }
      map = new AMap.Map('map', { zoom: 16, center: [lng, lat], resizeEnable: true });
      report({ type: 'ready' });
      map.on('moveend', function () {
        var c = map.getCenter();
        report({ type: 'moved', latitude: c.getLat(), longitude: c.getLng() });
      });
      var loaded = false;
      map.on('complete', function () { loaded = true; });
      setTimeout(function () {
        if (!loaded) {
          report({ type: 'error', message: '地图瓦片未能加载，多为 Key 无效或安全密钥缺失' });
        }
      }, 8000);
    }
    // 手机 GPS 给的是 WGS-84，高德地图用 GCJ-02，直接画会偏几百米
    function locate(latitude, longitude) {
      AMap.convertFrom([longitude, latitude], 'gps', function (status, result) {
        var ok = status === 'complete' && result && result.locations && result.locations.length > 0;
        var point = ok ? result.locations[0] : null;
        var lng = point ? point.getLng() : longitude;
        var lat = point ? point.getLat() : latitude;
        ensureMap(lng, lat);
        map.setZoomAndCenter(17, [lng, lat]);
        report({ type: 'located', latitude: lat, longitude: lng, converted: !!ok });
      });
    }
    var tag = document.createElement('script');
    tag.src = 'https://webapi.amap.com/maps?v=2.0&key=__JSKEY__';
    tag.onload = function () {
      if (typeof AMap === 'undefined') {
        report({ type: 'error', message: '地图脚本已下载但未定义 AMap' });
      } else {
        report({ type: 'sdk' });
      }
    };
    tag.onerror = function () {
      report({ type: 'error', message: '地图脚本下载失败：网络不可达或被拦截' });
    };
    document.head.appendChild(tag);

    function handle(raw) {
      try {
        var msg = JSON.parse(raw);
        if (msg.type === 'getCenter' && map) {
          var c = map.getCenter();
          report({ type: 'center', latitude: c.getLat(), longitude: c.getLng() });
        } else if (msg.type === 'setCenter') {
          ensureMap(msg.longitude, msg.latitude);
          map.setZoomAndCenter(16, [msg.longitude, msg.latitude]);
        } else if (msg.type === 'locate') {
          locate(msg.latitude, msg.longitude);
        }
      } catch (e) {
        report({ type: 'error', message: String(e) });
      }
    }
    document.addEventListener('message', function (e) { handle(e.data); });
    window.addEventListener('message', function (e) { handle(e.data); });
  </script>
</body>
</html>"""


def _map_page(js_key: str, security_code: str | None) -> str:
    security = (
        f"window._AMapSecurityConfig = {{ securityJsCode: '{security_code}' }};"
        if security_code
        else ""
    )
    return _MAP_PAGE_TEMPLATE.replace("__SECURITY__", security).replace("__JSKEY__", js_key)


@page_router.get("/map/amap", include_in_schema=False)
def map_page(service: GeoService = Depends(get_geo_service)) -> Response:
    """地图选点页：由 WebView 直接按 URL 加载，带不了 Authorization，因此不鉴权。

    页面里只有地图与公开的 JS Key，不含任何用户数据。
    """
    js_key = service.js_key
    if js_key is None:
        return Response(
            content="<html><body>未配置 Web端(JS API) Key，地图选点不可用</body></html>",
            media_type="text/html",
        )
    return Response(
        content=_map_page(js_key, service.js_security_code),
        media_type="text/html",
        headers={"Cache-Control": "no-store"},
    )
