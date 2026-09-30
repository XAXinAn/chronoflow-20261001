package com.xatodo.agent.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/**
 * 智能助手「小安」的模型配置（spec §11 阶段三）。
 *
 * <p>指向阿里云百炼（DashScope）的 **OpenAI 兼容**地址
 * （`https://dashscope.aliyuncs.com/compatible-mode/v1`），换模型只改 `model` 一行。
 * 默认 `qwen3.6-flash`：实测在「中文 + 工具 + 流式」这个形状下首字最快、总耗时最短，
 * 且 flash 档单价低于 plus 档——这次「更快」与「更省」恰好是同一个选择。
 * 需要长上下文 / 多步推理时用环境变量切到 `qwen3.7-plus` 即可，代码不用动。
 *
 * <p><b>留空 = 未接入</b>：此时 `/ai/agent/chat` 直接返回 90002，App 保持现在的
 * 「小安还没有接入模型」文案与行为。宁可明说，也不要让界面看起来能用、点了却装死。
 */
@Component
@ConfigurationProperties(prefix = "xatodo.agent")
public class AgentProperties {

    /** 例如 https://dashscope.aliyuncs.com/compatible-mode/v1。 */
    private String baseUrl = "";

    /** 百炼的 API Key（只在服务端用，绝不编进 App）。 */
    private String apiKey = "";

    /** 默认 qwen3.6-flash；可切 qwen3.7-plus。 */
    private String model = "qwen3.6-flash";

    /**
     * 思考流开关。
     *
     * <p>默认**关**：这个助手的工具都很确定（查日程、找空闲、建/删日程），
     * 思考只会白白多花 reasoning token 与首字时间。开着也只影响成本，不影响正确性。
     */
    private boolean enableThinking = false;

    /** 单次回复的 token 上限。助手要的是短答案，超了也会被截断。 */
    private int maxTokens = 600;

    /** 整条流的超时（含工具循环）。 */
    private int timeoutSeconds = 90;

    /** 工具循环最多几轮——模型偶尔会来回调工具，必须有上限。 */
    private int maxToolRounds = 4;

    /** 只带最近多少条对话（客户端内存里的历史）。 */
    private int maxHistoryMessages = 10;

    /** 工具返回的日程条数上限（紧凑 JSON，避免把上下文撑爆）。 */
    private int eventLimit = 20;

    /** 解释「明天下午三点」这类相对时间用的时区。 */
    private String timezone = "Asia/Shanghai";

    /** 语音转写（spec §11 阶段三：长按说话）。 */
    private Asr asr = new Asr();

    public boolean configured() {
        return StringUtils.hasText(baseUrl) && StringUtils.hasText(apiKey) && StringUtils.hasText(model);
    }

    public boolean asrConfigured() {
        return configured() && StringUtils.hasText(asr.getUrl()) && StringUtils.hasText(asr.getModel());
    }

    /** ASR 的 Key：没单独配就用主 Key（同一个百炼账号）。 */
    public String asrApiKey() {
        return StringUtils.hasText(asr.getApiKey()) ? asr.getApiKey() : apiKey;
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    public String getApiKey() {
        return apiKey;
    }

    public void setApiKey(String apiKey) {
        this.apiKey = apiKey;
    }

    public String getModel() {
        return model;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public boolean isEnableThinking() {
        return enableThinking;
    }

    public void setEnableThinking(boolean enableThinking) {
        this.enableThinking = enableThinking;
    }

    public int getMaxTokens() {
        return maxTokens;
    }

    public void setMaxTokens(int maxTokens) {
        this.maxTokens = maxTokens;
    }

    public int getTimeoutSeconds() {
        return timeoutSeconds;
    }

    public void setTimeoutSeconds(int timeoutSeconds) {
        this.timeoutSeconds = timeoutSeconds;
    }

    public int getMaxToolRounds() {
        return maxToolRounds;
    }

    public void setMaxToolRounds(int maxToolRounds) {
        this.maxToolRounds = maxToolRounds;
    }

    public int getMaxHistoryMessages() {
        return maxHistoryMessages;
    }

    public void setMaxHistoryMessages(int maxHistoryMessages) {
        this.maxHistoryMessages = maxHistoryMessages;
    }

    public int getEventLimit() {
        return eventLimit;
    }

    public void setEventLimit(int eventLimit) {
        this.eventLimit = eventLimit;
    }

    public String getTimezone() {
        return timezone;
    }

    public void setTimezone(String timezone) {
        this.timezone = timezone;
    }

    public Asr getAsr() {
        return asr;
    }

    public void setAsr(Asr asr) {
        this.asr = asr;
    }

    /**
     * 语音转写配置。
     *
     * <p>百炼的语音识别不在 OpenAI 兼容的那套 `/chat/completions` 里，
     * 而是多模态生成接口（body 里放 base64 音频），因此地址单独可配。
     * 音频**只在内存里转 base64 转发，不落盘**（spec §11）。
     */
    public static class Asr {

        private String url = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

        private String apiKey = "";

        private String model = "qwen3-asr-flash";

        private int timeoutSeconds = 60;

        /** 转写语言提示；留空交给模型自动判定。 */
        private String language = "";

        /** 单次上传的音频上限。60 秒的 m4a 通常不到 1 MB，超了多半是传错了文件。 */
        private long maxBytes = 5L * 1024 * 1024;

        public String getUrl() {
            return url;
        }

        public void setUrl(String url) {
            this.url = url;
        }

        public String getApiKey() {
            return apiKey;
        }

        public void setApiKey(String apiKey) {
            this.apiKey = apiKey;
        }

        public String getModel() {
            return model;
        }

        public void setModel(String model) {
            this.model = model;
        }

        public int getTimeoutSeconds() {
            return timeoutSeconds;
        }

        public void setTimeoutSeconds(int timeoutSeconds) {
            this.timeoutSeconds = timeoutSeconds;
        }

        public String getLanguage() {
            return language;
        }

        public void setLanguage(String language) {
            this.language = language;
        }

        public long getMaxBytes() {
            return maxBytes;
        }

        public void setMaxBytes(long maxBytes) {
            this.maxBytes = maxBytes;
        }
    }
}
