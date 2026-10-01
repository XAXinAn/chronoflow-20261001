package com.chronoflow.agent.web;

import com.chronoflow.agent.service.AgentTextParseService;
import com.chronoflow.agent.service.ParsedEventDraft;
import com.chronoflow.auth.security.CurrentIdentity;
import com.chronoflow.common.api.ApiResponse;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;

/**
 * 「图片识别日程」的第二段：手机端 OCR 出文字，这里交给云端模型理解（spec §4.1.9）。
 *
 * <p>`POST /api/v1/ai/events/parse-text`。与 {@code /ai/events/recognize}（整图上传给模型）
 * 的区别：**图片不出手机**，这里只收文字；OCR 用手机本地能力（中文准且免费），
 * 模型只负责「一段通知里有几件事、哪句是时间」这种理解活。
 */
@RestController
@RequestMapping("/api/v1/ai/events")
@SecurityRequirement(name = "bearerAuth")
public class AgentTextParseController {

    private final AgentTextParseService service;

    public AgentTextParseController(AgentTextParseService service) {
        this.service = service;
    }

    @PostMapping("/parse-text")
    public ApiResponse<ParseTextResponse> parse(@RequestBody ParseTextRequest request) {
        CurrentIdentity.require();
        String timezone = request == null || request.timezone() == null
                ? "Asia/Shanghai" : request.timezone();
        String today = request == null || request.today() == null
                ? LocalDate.now(ZoneId.of(timezone)).toString() : request.today();
        List<ParsedEventDraft> items = service.parse(
                request == null ? null : request.text(), today, timezone);
        return ApiResponse.ok(new ParseTextResponse(items));
    }

    /**
     * @param text     OCR 出来的文字（手机端 ML Kit 的结果）
     * @param today    客户端认为的「今天」（`YYYY-MM-DD`）；不给就按服务端日期算
     * @param timezone 时区；不给按 Asia/Shanghai
     */
    public record ParseTextRequest(String text, String today, String timezone) {
    }

    /**
     * 解析出来的日程草稿：`items[].at` **可以缺失**（通知里根本没写日期），
     * 由 App 的确认页让用户补；`items[].timezone` 是解释 `at` 用的时区。
     */
    public record ParseTextResponse(List<ParsedEventDraft> items) {
    }
}
