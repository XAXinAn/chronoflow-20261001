const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * 自带的系统定位模块（Android，不依赖 Google Play 服务）。
 *
 * <p>**为什么必须自己写**：`expo-location` 在 Android 上只用 GMS 的融合定位
 * (`com.google.android.gms.location.FusedLocationProviderClient`)。华为等没有 GMS 的机型上
 * `getCurrentPositionAsync` 与 `getLastKnownPositionAsync` **必然失败**——用户看到的就是
 * 「授权了定位，位置还是取不到」（真机反馈：华为 Mate 70）。
 *
 * <p>这里直读 Android 框架自带的 `LocationManager`：不需要 GMS、不需要 https 安全上下文
 * （浏览器定位 API 在 http 页面上会被拒），精度也更好。iOS 侧不注入本模块，
 * App 会退回 `expo-location`（CoreLocation 在 iOS 上本来就是好的）。
 *
 * <p>写法与 `withOnnxRuntime` 一致：CNG 的 prebuild 每次重建 `android/`，
 * 所以源码与注册都必须在插件里做，不能手工改 `android/` 下的文件。
 */
const JAVA_PACKAGE = 'com.chronoflow.frontend';
const JAVA_SOURCE = `package ${JAVA_PACKAGE};

import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;

/**
 * 系统定位（Android 框架自带的 LocationManager）。
 *
 * <p>为什么不直接用 expo-location：它在 Android 上走 GMS 融合定位，没有 Google 服务的
 * 机型（华为等）取位置必然失败。这里直读框架 API，任何 Android 机型都能用。
 *
 * <p>只暴露「取一次当前位置」这一件事：目标是拿到一个可用的坐标，
 * 不需要持续更新、不需要地理围栏，接口越小越不容易出问题。
 */
public class SystemLocationModule extends ReactContextBaseJavaModule {

    public static final String NAME = "ChronoflowLocation";

    /** 系统定位给不出新位置时，最多等这么久（毫秒） */
    private static final long DEFAULT_TIMEOUT_MS = 15000L;
    private static final long MAX_TIMEOUT_MS = 60000L;
    /** 缓存位置超过这个年龄就不算「当前位置」（毫秒） */
    private static final long LAST_KNOWN_MAX_AGE_MS = 120000L;

    public SystemLocationModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return NAME;
    }

    @ReactMethod
    public void getCurrentPosition(double timeoutMs, Promise promise) {
        long timeout = timeoutMs > 0 ? (long) timeoutMs : DEFAULT_TIMEOUT_MS;
        if (timeout > MAX_TIMEOUT_MS) {
            timeout = MAX_TIMEOUT_MS;
        }
        Context context = getReactApplicationContext();
        boolean coarse = hasPermission(context, android.Manifest.permission.ACCESS_COARSE_LOCATION);
        boolean fine = hasPermission(context, android.Manifest.permission.ACCESS_FINE_LOCATION);
        if (!coarse && !fine) {
            promise.reject("E_LOCATION_PERMISSION", "没有定位权限");
            return;
        }

        LocationManager manager =
                (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) {
            promise.reject("E_LOCATION_UNAVAILABLE", "系统没有定位服务");
            return;
        }

        String provider = null;
        if (fine && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            provider = LocationManager.GPS_PROVIDER;
        } else if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            provider = LocationManager.NETWORK_PROVIDER;
        } else if (fine && manager.isProviderEnabled(LocationManager.PASSIVE_PROVIDER)) {
            provider = LocationManager.PASSIVE_PROVIDER;
        }
        if (provider == null) {
            promise.reject("E_LOCATION_DISABLED", "系统定位服务未开启");
            return;
        }

        // 先看有没有还算新鲜的缓存位置：有就立刻返回，别让用户对着转圈等 GPS 冷启动
        Location cached = lastKnown(manager, provider, context);
        if (cached != null && isFresh(cached)) {
            promise.resolve(toMap(cached));
            return;
        }

        final String activeProvider = provider;
        final Handler handler = new Handler(Looper.getMainLooper());
        final boolean[] settled = {false};

        final LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                if (settled[0]) {
                    return;
                }
                settled[0] = true;
                manager.removeUpdates(this);
                promise.resolve(toMap(location));
            }

            @Override
            public void onProviderEnabled(String name) {
            }

            @Override
            public void onProviderDisabled(String name) {
            }

            @Override
            public void onStatusChanged(String name, int status, Bundle extras) {
            }
        };

        Runnable onTimeout = () -> {
            if (settled[0]) {
                return;
            }
            settled[0] = true;
            manager.removeUpdates(listener);
            Location fallback = lastKnown(manager, activeProvider, context);
            if (fallback != null) {
                // 宁可给一个略旧的坐标并如实标注，也不要让「定位」永远失败
                promise.resolve(toMap(fallback));
            } else {
                promise.reject("E_LOCATION_TIMEOUT", "定位超时，请到空旷处重试或直接搜索地点");
            }
        };

        try {
            handler.postDelayed(onTimeout, timeout);
            manager.requestLocationUpdates(activeProvider, 0L, 0f, listener, Looper.getMainLooper());
        } catch (SecurityException ex) {
            handler.removeCallbacks(onTimeout);
            promise.reject("E_LOCATION_PERMISSION", "没有定位权限");
        } catch (RuntimeException ex) {
            handler.removeCallbacks(onTimeout);
            promise.reject("E_LOCATION_UNAVAILABLE", String.valueOf(ex.getMessage()));
        }
    }

    private static boolean hasPermission(Context context, String permission) {
        // minSdk 24 起 Context#checkSelfPermission 直接在框架里，不用 androidx 那一层
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private static Location lastKnown(LocationManager manager, String provider, Context context) {
        try {
            return manager.getLastKnownLocation(provider);
        } catch (SecurityException | IllegalArgumentException ex) {
            return null;
        }
    }

    private static boolean isFresh(Location location) {
        long age = System.currentTimeMillis() - location.getTime();
        return age >= 0 && age <= LAST_KNOWN_MAX_AGE_MS;
    }

    private static WritableMap toMap(Location location) {
        WritableMap map = Arguments.createMap();
        map.putDouble("latitude", location.getLatitude());
        map.putDouble("longitude", location.getLongitude());
        map.putDouble("accuracy", location.hasAccuracy() ? location.getAccuracy() : -1);
        map.putString("provider", location.getProvider());
        map.putDouble("timestamp", location.getTime());
        return map;
    }
}
`;

const PACKAGE_SOURCE = `package ${JAVA_PACKAGE};

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** 注册 {@link SystemLocationModule}（见 app/plugins/withSystemLocation.js）。 */
public class SystemLocationPackage implements ReactPackage {

    @Override
    public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
        List<NativeModule> modules = new ArrayList<>();
        modules.add(new SystemLocationModule(reactContext));
        return modules;
    }

    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
        return Collections.emptyList();
    }
}
`;

const FILES = {
  'SystemLocationModule.java': JAVA_SOURCE,
  'SystemLocationPackage.java': PACKAGE_SOURCE,
};

module.exports = function withSystemLocation(config) {
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const projectRoot = cfg.modRequest.platformProjectRoot; // .../android
      const packagePath = path.join(
        projectRoot,
        'app',
        'src',
        'main',
        'java',
        ...JAVA_PACKAGE.split('.'),
      );
      fs.mkdirSync(packagePath, { recursive: true });
      for (const [name, source] of Object.entries(FILES)) {
        fs.writeFileSync(path.join(packagePath, name), source, 'utf8');
      }
      return cfg;
    },
  ]);

  return withMainApplication(config, (cfg) => {
    // Kotlin 模板：先补 import，再往 PackageList 的 apply 块里 add 一次
    let contents = cfg.modResults.contents;
    if (!contents.includes(`${JAVA_PACKAGE}.SystemLocationPackage`)) {
      contents = contents.replace(
        /^(import expo\.modules\.ExpoReactHostFactory)$/m,
        `$1\nimport ${JAVA_PACKAGE}.SystemLocationPackage`,
      );
      contents = contents.replace(
        /PackageList\(this\)\.packages\.apply\s*\{/,
        'PackageList(this).packages.apply {\n          add(SystemLocationPackage()) // [withSystemLocation] 手工注册',
      );
      cfg.modResults.contents = contents;
    }
    return cfg;
  });
};
