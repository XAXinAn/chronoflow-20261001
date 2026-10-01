package com.chronoflow.bootstrap;

import com.chronoflow.bootstrap.config.AppReleaseProperties;
import com.chronoflow.bootstrap.web.SystemController.AppReleaseInfo;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 应用内更新的发布信息（spec §4.1.11）。
 *
 * <p>纯逻辑测试，不启 Spring：这里要钉住的是「**没配置就不能编出更新来**」——
 * 版本发布是运维配置，配错了最坏的结果是全员被挡在强制更新页，所以边界要写死。
 */
class AppReleaseTest {

    private static AppReleaseProperties configured() {
        AppReleaseProperties properties = new AppReleaseProperties();
        properties.setVersionName("0.2.0");
        properties.setVersionCode(2);
        properties.setApkUrl("/downloads/app-0.2.0.apk");
        properties.setSizeBytes(78_643_200L);
        properties.setSha256("abc123");
        properties.setChangelog("图片识别日程 | 草稿可编辑 ||修复 9 月重复日程展开");
        properties.setMinSupportedVersionCode(2);
        properties.setPublishedAt("2026-10-01T12:00:00Z");
        return properties;
    }

    @Test
    @DisplayName("没配版本号或包地址 = 不提供应用内更新，回一个空版本而不是编一个")
    void unconfiguredReturnsNothingToUpdate() {
        AppReleaseInfo none = AppReleaseInfo.from(new AppReleaseProperties());
        assertThat(none.versionCode()).isZero();
        assertThat(none.apkUrl()).isNull();
        assertThat(none.changelog()).isEmpty();
        assertThat(none.force()).isFalse();

        // 只配了版本号、没配包地址：同样是「不提供」（否则 App 会去下载一个空地址）
        AppReleaseProperties half = new AppReleaseProperties();
        half.setVersionCode(3);
        assertThat(AppReleaseInfo.from(half).versionCode()).isZero();
        assertThat(AppReleaseInfo.from(half).apkUrl()).isNull();
    }

    @Test
    @DisplayName("配了就把发布信息原样带出来：版本、包地址、校验值、强更与下限")
    void configuredCarriesEveryField() {
        AppReleaseInfo info = AppReleaseInfo.from(configured());

        assertThat(info.versionName()).isEqualTo("0.2.0");
        assertThat(info.versionCode()).isEqualTo(2);
        assertThat(info.apkUrl()).isEqualTo("/downloads/app-0.2.0.apk");
        assertThat(info.sizeBytes()).isEqualTo(78_643_200L);
        assertThat(info.sha256()).isEqualTo("abc123");
        // `|` 分隔的多条说明：去空白、丢空项（上面那条里故意留了个空段）
        assertThat(info.changelog()).containsExactly("图片识别日程", "草稿可编辑", "修复 9 月重复日程展开");
        assertThat(info.minSupportedVersionCode()).isEqualTo(2);
        assertThat(info.publishedAt()).isEqualTo("2026-10-01T12:00:00Z");
    }

    @Test
    @DisplayName("版本名留空时回退成版本号：用户看不懂 versionCode，但总比空着强")
    void blankVersionNameFallsBackToCode() {
        AppReleaseProperties properties = configured();
        properties.setVersionName("  ");
        assertThat(AppReleaseInfo.from(properties).versionName()).isEqualTo("2");
    }
}
