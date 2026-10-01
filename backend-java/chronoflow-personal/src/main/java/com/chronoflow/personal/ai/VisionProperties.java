package com.chronoflow.personal.ai;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/**
 * 本地多模态识别配置（spec §4.1.9）。
 *
 * <p>指向**本机 / 内网**的 OpenAI 兼容推理服务（Ollama、vLLM、LM Studio 等都能起这个接口）。
 * 刻意不接第三方云：日程内容属于隐私数据，不该为了 OCR 出网。
 */
@Component
@ConfigurationProperties(prefix = "chronoflow.ai.vision")
public class VisionProperties {

    /** 例如 http://localhost:11434/v1（Ollama）或 http://127.0.0.1:8000/v1。留空表示未接入。 */
    private String baseUrl = "";

    /** 模型名，例如 qwen2.5vl:3b / minicpm-v。 */
    private String model = "";

    /** 本地服务一般不需要 Key，留空即可（有些网关要）。 */
    private String apiKey = "";

    /** 图片识别比文本慢，给足超时。 */
    private int timeoutSeconds = 60;

    /**
     * 结构化输出的约束方式（spec §4.1.9）：
     * <ul>
     *   <li>`json_object`（默认）：OpenAI 兼容的 JSON 模式，支持面最广；</li>
     *   <li>`json_schema`：附带 JSON Schema 的严格模式（vLLM / 新版 Ollama 支持），
     *       约束最强，模型连字段名都编不了；</li>
     *   <li>`none`：不发约束，只靠提示词（仅用于排查兼容性问题）。</li>
     * </ul>
     */
    private String structuredOutput = "json_object";

    /** 解析失败时最多尝试几次（含首次）。第二次会把上一次的坏输出回灌给模型让它修。 */
    private int maxAttempts = 2;

    public boolean configured() {
        return StringUtils.hasText(baseUrl) && StringUtils.hasText(model);
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    public String getModel() {
        return model;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public String getApiKey() {
        return apiKey;
    }

    public void setApiKey(String apiKey) {
        this.apiKey = apiKey;
    }

    public int getTimeoutSeconds() {
        return timeoutSeconds;
    }

    public void setTimeoutSeconds(int timeoutSeconds) {
        this.timeoutSeconds = timeoutSeconds;
    }

    public String getStructuredOutput() {
        return structuredOutput;
    }

    public void setStructuredOutput(String structuredOutput) {
        this.structuredOutput = structuredOutput;
    }

    public int getMaxAttempts() {
        return maxAttempts;
    }

    public void setMaxAttempts(int maxAttempts) {
        this.maxAttempts = maxAttempts;
    }
}
