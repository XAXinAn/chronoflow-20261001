package com.xatodo.agent.web;

import com.xatodo.agent.dto.AgentDtos.AgentChatRequest;
import com.xatodo.agent.dto.AgentDtos.ApprovalRequest;
import com.xatodo.agent.service.AgentChatService;
import com.xatodo.common.api.ApiResponse;
import com.xatodo.auth.security.CurrentIdentity;
import com.xatodo.auth.security.IdentityPrincipal;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * 小安的对话流（spec §11 阶段三，Java 先行）。
 *
 * <p>`POST /api/v1/ai/agent/chat`，`text/event-stream`。事件有四种：
 * `status`（正在查日程…）、`delta`（正文增量）、`action`（待确认动作）、`done`（收尾 + 用量）；
 * 出错时发 `error`。**模型未配置时不开流**，直接返回统一信封 `90002`。
 */
@RestController
@RequestMapping("/api/v1/ai/agent")
@SecurityRequirement(name = "bearerAuth")
public class AgentChatController {

    private final AgentChatService service;

    public AgentChatController(AgentChatService service) {
        this.service = service;
    }

    @PostMapping(value = "/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter chat(@RequestBody(required = false) AgentChatRequest request,
                           HttpServletResponse response) {
        IdentityPrincipal principal = CurrentIdentity.require();
        /**
         * 两个响应头是流式的「开关」：
         * <ul>
         *   <li>{@code Cache-Control: no-cache}：中间层不许把这个响应缓存起来；</li>
         *   <li>{@code X-Accel-Buffering: no}：告诉 nginx 一类反代别缓冲。
         *       少了它，逐块到达会变成「转半天圈、然后一次性蹦出来」——功能没坏，体验全丢
         *       （部署侧另有一份 `proxy_buffering off`，两处都要有，谁漏了都难受）。</li>
         * </ul>
         */
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("X-Accel-Buffering", "no");
        return service.chat(principal.accountId(), request);
    }

    /**
     * 用户对一次授权请求的答复（mewcode 的 `PermissionReply`）。
     *
     * <p>写工具在对话流里阻塞等待它：允许就真正落库、拒绝就写一条「什么都没改」的工具结果，
     * 两条路都会让**同一条流**继续跑下去。所以这个端点必须能被同一个账号在流还没结束时调用。
     */
    @PostMapping("/approvals")
    public ApiResponse<Void> approve(@RequestBody ApprovalRequest request) {
        IdentityPrincipal principal = CurrentIdentity.require();
        service.approve(principal.accountId(), request);
        return ApiResponse.ok(null);
    }
}
