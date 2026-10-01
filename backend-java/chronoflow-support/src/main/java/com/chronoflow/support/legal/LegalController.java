package com.chronoflow.support.legal;

import org.springframework.core.io.ClassPathResource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * 合规文本的公开页面（隐私政策 / 用户协议 / 儿童隐私声明 / 双清单）。
 *
 * <p>为什么由后端出页面，而不是把文本写进 App：
 * 应用宝规范 §一-1 要求「提交的隐私政策链接内容必须与 App 内的隐私政策保证完全一致」。
 * 只要 App 用 WebView 打开**同一个地址**，两边就永远逐字一致；
 * 反过来把正文抄进 App，改一边忘一边是必然会发生的。
 *
 * <p>页面要求（规范 §一-2）：公开、免登录、纯静态、无脚本、无跳转、中文正常显示，
 * 能被自动化抓取分析。因此这里输出的是最朴素的 HTML，唯一的样式是几行内联 CSS。
 *
 * <p>正文来自 {@code docs/legal/*.md}——那是唯一事实来源，Maven 在打包时把它复制进
 * {@code classpath:/legal/}，因此改文案不需要改代码。
 */
@RestController
public class LegalController {

    /** 允许的文档 slug → 页面标题。白名单而非拼路径：路径穿越必须在一开始就不可能。 */
    private static final Map<String, String> DOCUMENTS = Map.of(
            "privacy-policy", "时纪流隐私政策",
            "user-agreement", "时纪流用户服务协议",
            "children-privacy", "时纪流儿童个人信息保护声明",
            "personal-info-collected", "时纪流已收集个人信息清单",
            "shared-info-with-third-parties", "时纪流与第三方共享个人信息清单");

    @GetMapping(value = "/api/v1/legal/{doc}", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> document(@PathVariable String doc) throws IOException {
        String title = DOCUMENTS.get(doc);
        if (title == null) {
            return ResponseEntity.notFound().build();
        }
        ClassPathResource resource = new ClassPathResource("legal/" + doc + ".md");
        if (!resource.exists()) {
            return ResponseEntity.notFound().build();
        }
        String markdown;
        try (InputStream stream = resource.getInputStream()) {
            markdown = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
        return ResponseEntity.ok()
                .contentType(new MediaType(MediaType.TEXT_HTML, StandardCharsets.UTF_8))
                // 文案随时可能为了合规更新，别让商店的抓取或 WebView 拿到旧版
                .cacheControl(CacheControl.noStore())
                .body(page(title, MarkdownRenderer.toHtml(markdown)));
    }

    private static String page(String title, String body) {
        return """
                <!DOCTYPE html>
                <html lang="zh-CN">
                <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <title>%s</title>
                <style>
                  html{-webkit-text-size-adjust:100%%}
                  body{margin:0;padding:24px 18px 64px;background:#fff;color:#1a1a1a;
                       font:16px/1.75 -apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
                  main{max-width:760px;margin:0 auto}
                  h1{font-size:24px;line-height:1.4;margin:0 0 8px}
                  h2{font-size:19px;margin:32px 0 12px;padding-top:8px;border-top:1px solid #ececec}
                  h3{font-size:17px;margin:24px 0 8px}
                  h4,h5,h6{font-size:16px;margin:20px 0 8px}
                  p,li{margin:8px 0}
                  ul,ol{padding-left:22px}
                  blockquote{margin:16px 0;padding:12px 16px;background:#f6f6f6;border-left:3px solid #999}
                  table{width:100%%;border-collapse:collapse;margin:14px 0;font-size:14px}
                  th,td{border:1px solid #e2e2e2;padding:8px 10px;text-align:left;vertical-align:top;word-break:break-word}
                  th{background:#fafafa}
                  code{background:#f4f4f4;padding:1px 4px;border-radius:3px;font-size:14px}
                  a{color:#0a58ca;word-break:break-all}
                  hr{border:0;border-top:1px solid #ececec;margin:28px 0}
                  strong{font-weight:600}
                </style>
                </head>
                <body><main>
                %s
                </main></body>
                </html>""".formatted(title, body);
    }
}
