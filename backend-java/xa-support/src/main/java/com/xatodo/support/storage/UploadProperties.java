package com.xatodo.support.storage;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 图片存储配置（spec §5.10）。
 *
 * <p>首版是**本地目录 + 静态映射**，这是有意为之：对象存储（MinIO/OSS）属外部依赖（spec §8），
 * 但没有它就不该做不了头像与反馈图片。接口与存储实现解耦，换 MinIO 时业务侧不感知。
 */
@Component
@ConfigurationProperties(prefix = "xatodo.upload")
public class UploadProperties {

    /** 落盘目录。生产上可以指到独立的数据盘或挂载卷。 */
    private String dir = "./data/uploads";

    /** 单文件大小上限（字节），默认 5 MB（spec §5.10）。 */
    private long maxBytes = 5L * 1024 * 1024;

    public String getDir() {
        return dir;
    }

    public void setDir(String dir) {
        this.dir = dir;
    }

    public long getMaxBytes() {
        return maxBytes;
    }

    public void setMaxBytes(long maxBytes) {
        this.maxBytes = maxBytes;
    }
}
