package com.xatodo.common.validation;

import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;

import java.util.List;

/**
 * 图片地址校验（spec §5.10）。
 *
 * <p>只接受**本服务上传通道产出的相对 URL**。不校验的话，客户端可以把任意外链塞进来——
 * 那等于让别人的服务在我们的用户界面上打广告或埋追踪，后台也会跟着去取。
 *
 * <p>反馈图片（§4.1.9）与待办图片（§4.1.3）共用这一份规则，避免两处慢慢长歪。
 */
public final class ImageUrls {

    /** 单条记录最多几张图（与 App 侧的选择上限一致）。 */
    public static final int MAX_COUNT = 9;

    private ImageUrls() {
    }

    public static List<String> requireValid(List<String> images) {
        if (images == null || images.isEmpty()) {
            return List.of();
        }
        if (images.size() > MAX_COUNT) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "最多上传 " + MAX_COUNT + " 张图片");
        }
        for (String image : images) {
            if (image == null || !image.startsWith("/uploads/") || image.contains("..")) {
                throw BizException.of(ErrorCode.PARAM_INVALID, "图片地址非法: " + image);
            }
        }
        return List.copyOf(images);
    }
}
