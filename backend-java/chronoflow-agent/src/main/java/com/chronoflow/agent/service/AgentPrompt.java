package com.chronoflow.agent.service;

import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * 系统提示词的加载与渲染（spec §11 阶段三）。
 *
 * <p>提示词正文放在 `src/main/resources/agent/prompt.md` 里，而不是拼在 Java 字符串中：
 * 它是**产品文案**，需要逐句 review、需要 diff、以后 Python 版还要复用；
 * 藏在 StringBuilder 里既改不清也读不懂（这一轮之前就是那样）。
 *
 * <p>{@link #VERSION} 随每轮 token 用量一起进日志：线上效果有变化时，
 * 第一件事应该是确认"跑的是哪一版提示词"。
 */
@Component
public class AgentPrompt {

    /** 改动提示词正文时**必须**一起改这里（只改日期与序号即可）。 */
    public static final String VERSION = "2026-09-28.5";

    private static final String PATH = "agent/prompt.md";

    private final String template;

    public AgentPrompt() {
        this.template = readTemplate();
    }

    public String version() {
        return VERSION;
    }

    /** 把 {{占位符}} 换成实际内容；未提供的占位符替换为空串（绝不能把 {{...}} 原样送给模型）。 */
    public String render(Map<String, String> values) {
        String rendered = template;
        for (Map.Entry<String, String> entry : values.entrySet()) {
            rendered = rendered.replace("{{" + entry.getKey() + "}}",
                    entry.getValue() == null ? "" : entry.getValue());
        }
        return rendered.replaceAll("\\{\\{[a-z_]+}}", "");
    }

    private static String readTemplate() {
        try (var stream = new ClassPathResource(PATH).getInputStream()) {
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException ex) {
            throw new UncheckedIOException("加载提示词失败：" + PATH, ex);
        }
    }
}
