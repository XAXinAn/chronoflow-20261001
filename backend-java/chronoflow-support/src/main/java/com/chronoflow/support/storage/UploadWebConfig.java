package com.chronoflow.support.storage;

import org.springframework.context.annotation.Configuration;
import org.springframework.http.CacheControl;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.nio.file.Path;
import java.time.Duration;

/**
 * 把上传目录映射成 `/uploads/**`（spec §5.10）。
 *
 * <p>两个要点：
 * <ul>
 *   <li><b>必须免鉴权</b>：`<Image>` 直接按 URL 取图，带不了 Authorization 头。
 *       代价是这里不能放任何私有内容——所以只有头像与反馈图片走这条路；</li>
 *   <li><b>可以放开缓存</b>：文件名是内容哈希，同一 URL 的字节永远不会变，
 *       给一年缓存既省流量也不会读到旧图。</li>
 * </ul>
 */
@Configuration
public class UploadWebConfig implements WebMvcConfigurer {

    private final String location;

    public UploadWebConfig(UploadProperties properties) {
        String dir = Path.of(properties.getDir()).toAbsolutePath().normalize().toString();
        this.location = "file:" + (dir.endsWith("/") ? dir : dir + "/");
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        registry.addResourceHandler("/uploads/**")
                .addResourceLocations(location)
                .setCacheControl(CacheControl.maxAge(Duration.ofDays(365)).cachePublic());
    }
}
