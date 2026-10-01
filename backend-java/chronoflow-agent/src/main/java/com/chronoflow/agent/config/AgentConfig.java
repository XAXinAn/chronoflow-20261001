package com.chronoflow.agent.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.chronoflow.agent.model.AgentModelClient;
import com.chronoflow.agent.model.DashScopeAgentModelClient;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 智能助手的装配。
 *
 * <p>SSE 的转发是**阻塞读**上游流的，必须扔到独立线程上跑，否则会占死 Tomcat 的请求线程。
 * 用虚拟线程：这类任务几乎全程在等网络，虚拟线程既便宜又不会把平台线程池耗光。
 */
@Configuration
public class AgentConfig {

    @Bean(destroyMethod = "close")
    public ExecutorService agentStreamExecutor() {
        return Executors.newVirtualThreadPerTaskExecutor();
    }

    /**
     * 真实的模型客户端**始终注册**，是否可用由 {@link AgentProperties#configured()} 决定。
     *
     * <p>这样「未配置」是一条正常的业务分支（返回 90002），而不是靠 bean 缺失来表达——
     * bean 缺失会让测试里的替换与线上行为差别变大，也容易在装配期报难懂的错。
     */
    @Bean
    public AgentModelClient agentModelClient(AgentProperties properties, ObjectMapper objectMapper) {
        return new DashScopeAgentModelClient(properties, objectMapper);
    }
}
