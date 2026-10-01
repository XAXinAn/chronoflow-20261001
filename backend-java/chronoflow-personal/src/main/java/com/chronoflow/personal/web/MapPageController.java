package com.chronoflow.personal.web;

import com.chronoflow.personal.geo.GeoService;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 地图选点页（供 App 的 WebView 直接按 URL 加载）。
 *
 * <p>为什么不把这段 HTML 写在 App 里用 {@code source={{html}}} 内联加载：
 * 那种方式走的是 Android 的 {@code loadDataWithBaseURL}，高德 JS API v2 在这种
 * 「伪文档」里下能下到、却不会定义出 {@code AMap}（同一页面加载其它 CDN 脚本却正常）。
 * 换成真实 HTTP 页面后，页面有正常的文档环境（worker / blob / location），一切正常。
 *
 * <p>顺带的好处：JS Key 与安全密钥始终由服务端注入，换 Key 不需要发版；
 * 页面本身不含任何用户数据，因此放在 {@code /map/**} 这个免鉴权路径下。
 */
@RestController
public class MapPageController {

    private final GeoService geoService;

    public MapPageController(GeoService geoService) {
        this.geoService = geoService;
    }

    @GetMapping(value = "/map/amap", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> amapPage() {
        String jsKey = geoService.jsKey();
        if (jsKey == null) {
            return ResponseEntity.ok()
                    .contentType(MediaType.TEXT_HTML)
                    .body(unavailablePage());
        }
        return ResponseEntity.ok()
                .contentType(MediaType.TEXT_HTML)
                // 页面内容随配置变化，别让 WebView 缓存住旧 Key
                .header("Cache-Control", "no-store")
                .body(amapPage(jsKey, geoService.jsSecurityCode()));
    }

    private static String unavailablePage() {
        return """
                <!DOCTYPE html><html><head><meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1"></head>
                <body style="margin:0;display:flex;align-items:center;justify-content:center;
                             height:100vh;font:14px -apple-system,sans-serif;color:#6B6B6B">
                  未配置 Web端(JS API) Key，地图选点不可用
                </body></html>""";
    }

    private static String amapPage(String jsKey, String securityCode) {
        String securityConfig = securityCode == null ? ""
                : "window._AMapSecurityConfig = { securityJsCode: " + json(securityCode) + " };";
        return """
                <!DOCTYPE html>
                <html>
                <head>
                  <meta charset="utf-8">
                  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
                  <style>
                    html,body,#map{height:100%%;margin:0;padding:0;background:#f2f2f2}
                    /* 拿到「我的位置」之前不建图：先让用户看到定位中，
                       而不是先闪一个无关的城市再跳过来 */
                    #hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
                          font:14px -apple-system,sans-serif;color:#6B6B6B}
                  </style>
                  <script>%s</script>
                  <script>
                    // 脚本「下到了但没生效」时，异常信息是唯一线索，必须上报出来
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
                      if (map) {
                        return;
                      }
                      var hint = document.getElementById('hint');
                      if (hint) { hint.style.display = 'none'; }
                      map = new AMap.Map('map', { zoom: 16, center: [lng, lat], resizeEnable: true });
                      report({ type: 'ready' });
                      // 拖动结束后回报中心点，供端上实时反查地址
                      map.on('moveend', function () {
                        var c = map.getCenter();
                        report({ type: 'moved', latitude: c.getLat(), longitude: c.getLng() });
                      });
                      // Key 无效时高德不抛异常，只是瓦片永远拉不到、地图一片空白，
                      // 所以用 complete 事件兜底，别让用户只看到白屏。
                      var loaded = false;
                      map.on('complete', function () { loaded = true; });
                      setTimeout(function () {
                        if (!loaded) {
                          report({ type: 'error', message: '地图瓦片未能加载，多为 Key 无效或安全密钥缺失' });
                        }
                      }, 8000);
                    }

                    var tag = document.createElement('script');
                    tag.src = 'https://webapi.amap.com/maps?v=2.0&key=%s';
                    tag.onload = function () {
                      if (typeof AMap === 'undefined') {
                        report({ type: 'error', message: '地图脚本已下载但未定义 AMap' });
                      } else {
                        // SDK 就绪即可回报，此时还没有地图——等端上给出位置再建图
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
                          // 搜索选中 / 定位失败兜底：把地图（必要时先建出来）移过去
                          ensureMap(msg.longitude, msg.latitude);
                          map.setZoomAndCenter(16, [msg.longitude, msg.latitude]);
                        } else if (msg.type === 'locate') {
                          locate(msg.latitude, msg.longitude);
                        }
                      } catch (e) {
                        report({ type: 'error', message: String(e) });
                      }
                    }
                    // RN 侧 postMessage 在页面里表现为 document / window 的 message 事件，
                    // 不同 WebView 版本落点不同，两个都挂上最省事。
                    document.addEventListener('message', function (e) { handle(e.data); });
                    window.addEventListener('message', function (e) { handle(e.data); });

                    // 手机 GPS 给的是 WGS-84，高德地图用 GCJ-02，直接画会偏几百米。
                    // 交给 SDK 做一次坐标转换再落点，不能省。
                    function locate(latitude, longitude) {
                      AMap.convertFrom([longitude, latitude], 'gps', function (status, result) {
                        var ok = status === 'complete' && result
                                 && result.locations && result.locations.length > 0;
                        var point = ok ? result.locations[0] : null;
                        var lng = point ? point.getLng() : longitude;
                        var lat = point ? point.getLat() : latitude;
                        ensureMap(lng, lat);
                        map.setZoomAndCenter(17, [lng, lat]);
                        report({ type: 'located', latitude: lat, longitude: lng, converted: !!ok });
                      });
                    }
                  </script>
                </body>
                </html>""".formatted(securityConfig, jsKey);
    }

    /** 只用于把配置值安全地拼进 JS 字符串字面量。 */
    private static String json(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                default -> out.append(c);
            }
        }
        return out.append('"').toString();
    }
}
