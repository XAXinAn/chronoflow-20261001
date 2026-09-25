package com.xatodo.support.storage;

import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * 图片存储（spec §5.10）。
 *
 * <p>三条刻意的设计：
 * <ol>
 *   <li><b>格式按文件头判定，不信客户端声明的 MIME</b>：把 a.exe 改名成 a.jpg 并声明 image/jpeg
 *       是拦不住的，落盘扩展名由嗅探结果决定；</li>
 *   <li><b>文件名取内容哈希</b>：同一张图重复上传天然去重，也不会出现「用户可控的文件名」这种
 *       路径穿越风险（原始文件名一律不参与落盘路径）；</li>
 *   <li><b>没配对象存储也能用</b>：本地目录 + `/uploads/**` 静态映射，接口不绑具体存储。</li>
 * </ol>
 */
@Service
public class ImageStorage {

    private final Path root;
    private final long maxBytes;

    public ImageStorage(UploadProperties properties) {
        this.root = Path.of(properties.getDir()).toAbsolutePath().normalize();
        this.maxBytes = properties.getMaxBytes();
    }

    public StoredImage store(byte[] content) {
        if (content == null || content.length == 0) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "上传内容为空");
        }
        if (content.length > maxBytes) {
            throw BizException.of(ErrorCode.UPLOAD_TOO_LARGE,
                    "图片不能超过 " + (maxBytes / 1024 / 1024) + " MB");
        }
        ImageType type = ImageType.sniff(content);
        if (type == null) {
            throw BizException.of(ErrorCode.UPLOAD_TYPE_UNSUPPORTED,
                    "仅支持 JPG / PNG / WebP / GIF 图片");
        }

        String fileName = sha256Hex(content) + "." + type.extension();
        Path target = root.resolve(fileName);
        try {
            Files.createDirectories(root);
            if (!Files.exists(target)) {
                Files.write(target, content);
            }
        } catch (IOException ex) {
            throw new UncheckedIOException("图片写入失败: " + target, ex);
        }
        return new StoredImage("/uploads/" + fileName, content.length, type.contentType());
    }

    private static String sha256Hex(byte[] content) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
        } catch (NoSuchAlgorithmException ex) {
            // JDK 一定带 SHA-256；真没有的话属于环境坏了，直接暴露
            throw new IllegalStateException(ex);
        }
    }

    /** 受支持的图片类型：靠文件头（magic bytes）识别。 */
    enum ImageType {
        JPEG("jpg", "image/jpeg"),
        PNG("png", "image/png"),
        GIF("gif", "image/gif"),
        WEBP("webp", "image/webp");

        private final String extension;
        private final String contentType;

        ImageType(String extension, String contentType) {
            this.extension = extension;
            this.contentType = contentType;
        }

        public String extension() {
            return extension;
        }

        public String contentType() {
            return contentType;
        }

        static ImageType sniff(byte[] content) {
            if (startsWith(content, new byte[]{(byte) 0xFF, (byte) 0xD8, (byte) 0xFF})) {
                return JPEG;
            }
            if (startsWith(content, new byte[]{(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})) {
                return PNG;
            }
            if (startsWith(content, "GIF87a".getBytes(StandardCharsets.US_ASCII))
                    || startsWith(content, "GIF89a".getBytes(StandardCharsets.US_ASCII))) {
                return GIF;
            }
            // WebP：RIFF????WEBP
            if (startsWith(content, "RIFF".getBytes(StandardCharsets.US_ASCII))
                    && content.length >= 12
                    && new String(content, 8, 4, StandardCharsets.US_ASCII).equals("WEBP")) {
                return WEBP;
            }
            return null;
        }

        private static boolean startsWith(byte[] content, byte[] prefix) {
            if (content.length < prefix.length) {
                return false;
            }
            for (int i = 0; i < prefix.length; i++) {
                if (content[i] != prefix[i]) {
                    return false;
                }
            }
            return true;
        }
    }
}
