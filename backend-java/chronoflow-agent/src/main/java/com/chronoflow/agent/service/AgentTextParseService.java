package com.chronoflow.agent.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.chronoflow.agent.model.AgentMessage;
import com.chronoflow.agent.model.AgentModelClient;
import com.chronoflow.agent.model.CompletionRequest;
import com.chronoflow.agent.model.CompletionResult;
import com.chronoflow.agent.tool.AgentTimes;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

/**
 * 「OCR 文字 → 日程草稿」的云端解析（spec §4.1.9）。
 *
 * <p>为什么要分两段：手机端的端侧 OCR（PaddleOCR PP-OCRv4）**又准又不花钱、图片还不出手机**，
 * 而「理解一段通知里有几件事、哪句是‘要你去做的事’」是模型更擅长的事。手机上跑小模型试过
 * （Qwen2.5-0.5B + llama.rn），
 * 结构上跑得通，但「一份通知抽多条」上明显不够用，所以解析这一段改走服务端模型（百炼）。
 *
 * <p><b>图片仍然不出手机</b>：这里只收 OCR 出来的**文字**，收不到原图。
 *
 * <p>抽取口径全部写在提示词 {@code agent/vision-prompt.md} 里（与 Python 版逐字节相同）：
 * 只抽「要你做的事」，日期有就写、没有就留空，不猜时刻。这里只负责调用与容错解析。
 */
@Service
public class AgentTextParseService {

    private static final Logger log = LoggerFactory.getLogger(AgentTextParseService.class);
    private static final String PROMPT_PATH = "agent/vision-prompt.md";
    /** OCR 文字上限：一张通知再长也就几千字，超了多半是把整本书拍进来了。 */
    private static final int MAX_TEXT_LENGTH = 4000;

    private final AgentModelClient modelClient;
    private final ObjectMapper objectMapper;
    private final String template;

    public AgentTextParseService(AgentModelClient modelClient, ObjectMapper objectMapper) {
        this.modelClient = modelClient;
        this.objectMapper = objectMapper;
        this.template = readTemplate();
    }

    /**
     * @param today    今天（`YYYY-MM-DD`）：相对时间靠提示词换算，模型自己不算日期
     * @param timezone 解释时间用的时区，也原样回带进每一条
     */
    public List<ParsedEventDraft> parse(String text, String today, String timezone) {
        if (!modelClient.available()) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "解析模型未配置");
        }
        if (!StringUtils.hasText(text)) {
            throw BizException.of(ErrorCode.PARAM_MISSING, "缺少要解析的文字");
        }
        String trimmed = text.length() > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;
        ZoneId zone = ZoneId.of(StringUtils.hasText(timezone) ? timezone : "Asia/Shanghai");
        String prompt = template
                .replace("{{today}}", today == null ? "" : today)
                .replace("{{timezone}}", zone.getId())
                .replace("{{text}}", trimmed);

        long startedAt = System.nanoTime();
        CompletionResult result = modelClient.complete(
                // 结构化输出：JSON 模式 + 温度 0；这一段不需要流式转发，攒完一次性返回
                CompletionRequest.structured(List.of(AgentMessage.user(prompt))),
                delta -> { });
        long modelMs = (System.nanoTime() - startedAt) / 1_000_000;
        List<ParsedEventDraft> drafts = parseItems(result.text(), zone);
        // 耗时埋点：OCR 在手机端（客户端日志），这里只报服务端这一段（绝大部分是模型时间）
        log.info("识别解析：模型 {} ms，文字 {} 字 → 草稿 {} 条（{}）",
                modelMs, trimmed.length(), drafts.size(), modelClient.providerName());
        return drafts;
    }

    /**
     * 容错解析：模型可能包 ```json、前后带解释；解析不出来就当「没识别到」，而不是报错。
     *
     * <p>**`at` 缺失是合法结果**（通知里没写日期），照常返回这一条，交给 App 的确认页补。
     */
    List<ParsedEventDraft> parseItems(String reply, ZoneId zone) {
        String json = extractJsonObject(reply);
        if (json == null) {
            return List.of();
        }
        try {
            JsonNode items = objectMapper.readTree(json).path("items");
            if (!items.isArray()) {
                return List.of();
            }
            List<ParsedEventDraft> drafts = new ArrayList<>();
            for (JsonNode item : items) {
                ParsedEventDraft draft = toDraft(item, zone);
                if (draft != null) {
                    drafts.add(draft);
                }
            }
            return drafts;
        } catch (IOException ex) {
            return List.of();
        }
    }

    private ParsedEventDraft toDraft(JsonNode item, ZoneId zone) {
        String title = text(item, "title");
        if (!StringUtils.hasText(title)) {
            // 没标题的条目没法确认也没法建，丢掉——宁可少一条，也别给用户一条空白卡
            return null;
        }
        Instant at = AgentTimes.parse(text(item, "at"), zone);
        return new ParsedEventDraft(
                title.trim(),
                at == null ? null : OffsetDateTime.ofInstant(at, zone).toString(),
                // 时区以服务端为准：模型偶尔会漏或写错，而 at 已经是按请求时区解析的，
                // 回带别的时区只会让两者对不上。客户端靠这个时区把时间落到正确的那一天。
                zone.getId(),
                text(item, "locationName"),
                text(item, "description"));
    }

    /** 抽第一个配平的 `{...}`：模型爱在前后加解释或 ```json 围栏。 */
    static String extractJsonObject(String raw) {
        if (raw == null) {
            return null;
        }
        int start = raw.indexOf('{');
        if (start < 0) {
            return null;
        }
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = start; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (c == '\\') {
                    escaped = true;
                } else if (c == '"') {
                    inString = false;
                }
                continue;
            }
            if (c == '"') {
                inString = true;
            } else if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) {
                    return raw.substring(start, i + 1);
                }
            }
        }
        return null;
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull() || !value.isValueNode()) {
            return null;
        }
        String raw = value.asText("");
        return raw.isBlank() ? null : raw;
    }

    private static String readTemplate() {
        try (var stream = new ClassPathResource(PROMPT_PATH).getInputStream()) {
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException ex) {
            throw new UncheckedIOException("加载识别解析提示词失败：" + PROMPT_PATH, ex);
        }
    }
}
