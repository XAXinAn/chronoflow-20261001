package com.chronoflow.personal.ai;

import java.util.List;

/**
 * 图片 → 日程草稿（spec §4.1.9）。
 *
 * <p>抽成接口是为了「换模型只换实现」：本地轻量多模态、更小的端侧模型、以后接云端，
 * 对上层（控制器与 App）都是一样的返回结构。
 */
public interface VisionEventRecognizer {

    /** 当前实现的名字，如实上报给 App（未接入时 App 要能明确提示）。 */
    String providerName();

    /** 模型是否已配置；未配置时调用应抛 90002，而不是返回空列表冒充「图里没有日程」。 */
    boolean configured();

    /**
     * @param today    今天的日期（供模型解析「明天下午三点」这类相对时间）
     * @param timezone 用于解释相对时间的时区
     */
    List<RecognizedEvent> recognize(byte[] image, String contentType, String today, String timezone);
}
