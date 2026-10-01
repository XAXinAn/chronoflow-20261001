package com.xatodo.bootstrap.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import java.util.Arrays;
import java.util.List;

/**
 * App 新版本发布信息（spec §4.1.11「应用内更新」）。
 *
 * <p>为什么放在服务端配置里而不是写死在 App 里：版本发布是**运维动作**，不是发版动作。
 * 把「最新版本号 / 安装包地址 / 更新说明 / 是否强制」做成配置，改完重启（或只改环境变量）
 * 就能推送新版本，不用动代码。
 *
 * <p>**未配置（versionCode = 0 或 apkUrl 为空）= 这个部署不提供应用内更新**：
 * `/system/app-release` 会如实回一个空版本，App 据此不弹任何东西，而不是编一个版本号出来。
 */
@Component
@ConfigurationProperties(prefix = "xatodo.app-release")
public class AppReleaseProperties {

    /** 展示给用户的版本名，例如 0.2.0；留空则回退成 versionCode。 */
    private String versionName = "";

    /** 版本号（整数，必须单调递增）；0 表示没配置发布信息。 */
    private int versionCode = 0;

    /** 安装包地址：可以是绝对 URL，也可以是相对路径（如 /downloads/app-0.2.0.apk，App 拼当前 API 域名）。 */
    private String apkUrl = "";

    /** 安装包字节数（可选，用于提示「约 xx MB」）。 */
    private long sizeBytes = 0;

    /**
     * 安装包的 SHA-256（可选）。App 侧只对**大小**做校验（挡住被截断的下载），
     * 哈希留给运维/人工核对——端上多引一个哈希库不值得。
     */
    private String sha256 = "";

    /** 更新说明：**用 `|` 分隔多条**（环境变量里写不了列表，这是最省事又不会歧义的写法）。 */
    private String changelog = "";

    /** 是否强制更新：true 时 App 不给「稍后」，装不上就一直挡在更新页。 */
    private boolean force = false;

    /** 低于这个版本号的客户端**必须**更新（服务端加了这个下限，老客户端也躲不掉）。 */
    private int minSupportedVersionCode = 0;

    /** 发布时间（ISO-8601，可选，纯粹给用户看的）。 */
    private String publishedAt = "";

    /** 配了版本号与包地址才算「这个部署提供了应用内更新」。 */
    public boolean configured() {
        return versionCode > 0 && StringUtils.hasText(apkUrl);
    }

    /** 更新说明按 `|` 拆条：去空白、丢空项（末尾多个 `|` 也不会多出一个空条目）。 */
    public List<String> changelogItems() {
        if (!StringUtils.hasText(changelog)) {
            return List.of();
        }
        return Arrays.stream(changelog.split("\\|"))
                .map(String::trim)
                .filter(StringUtils::hasText)
                .toList();
    }

    /** 版本名缺省回退成版本号——用户看不懂 versionCode，但总比留空强。 */
    public String displayVersionName() {
        return StringUtils.hasText(versionName) ? versionName : String.valueOf(versionCode);
    }

    public String getVersionName() {
        return versionName;
    }

    public void setVersionName(String versionName) {
        this.versionName = versionName;
    }

    public int getVersionCode() {
        return versionCode;
    }

    public void setVersionCode(int versionCode) {
        this.versionCode = versionCode;
    }

    public String getApkUrl() {
        return apkUrl;
    }

    public void setApkUrl(String apkUrl) {
        this.apkUrl = apkUrl;
    }

    public long getSizeBytes() {
        return sizeBytes;
    }

    public void setSizeBytes(long sizeBytes) {
        this.sizeBytes = sizeBytes;
    }

    public String getSha256() {
        return sha256;
    }

    public void setSha256(String sha256) {
        this.sha256 = sha256;
    }

    public String getChangelog() {
        return changelog;
    }

    public void setChangelog(String changelog) {
        this.changelog = changelog;
    }

    public boolean isForce() {
        return force;
    }

    public void setForce(boolean force) {
        this.force = force;
    }

    public int getMinSupportedVersionCode() {
        return minSupportedVersionCode;
    }

    public void setMinSupportedVersionCode(int minSupportedVersionCode) {
        this.minSupportedVersionCode = minSupportedVersionCode;
    }

    public String getPublishedAt() {
        return publishedAt;
    }

    public void setPublishedAt(String publishedAt) {
        this.publishedAt = publishedAt;
    }
}
