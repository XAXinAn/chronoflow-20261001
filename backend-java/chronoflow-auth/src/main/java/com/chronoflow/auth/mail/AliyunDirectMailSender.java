package com.chronoflow.auth.mail;

import com.chronoflow.auth.sms.AliyunSmsSigner;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

/**
 * 阿里云邮件推送（DirectMail）通道，RPC 接口 {@code SingleSendMail}。
 *
 * <p>**不引 SDK**：官方 SDK 会带进整套 tea 依赖，而这套 RPC 签名与短信完全同源——
 * 直接复用 {@link AliyunSmsSigner}（那个类名里的 sms 是历史，签名逻辑本身与业务无关）。
 * 好处是离线可测：签名对不对不用真发一封信才知道。
 *
 * <p>与老项目同源：发信地址 {@code noreply@xaxinan.top}、别名「时纪流」。
 * 配置不完整直接报错，不静默降级——「以为发了邮件、其实一封没发」是最坑的失败方式。
 */
@Component
@ConditionalOnProperty(name = "chronoflow.auth.mail.provider", havingValue = "aliyun")
public class AliyunDirectMailSender implements EmailSender {

    private static final Logger log = LoggerFactory.getLogger(AliyunDirectMailSender.class);
    private static final DateTimeFormatter TIMESTAMP =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC);
    private static final Duration SEND_TIMEOUT = Duration.ofSeconds(8);

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();
    private final Clock clock = Clock.systemUTC();

    @Value("${chronoflow.auth.mail.access-key-id:}")
    private String accessKeyId;
    @Value("${chronoflow.auth.mail.access-key-secret:}")
    private String accessKeySecret;
    @Value("${chronoflow.auth.mail.account-name:}")
    private String accountName;
    @Value("${chronoflow.auth.mail.from-alias:}")
    private String fromAlias;
    @Value("${chronoflow.auth.mail.endpoint:dm.aliyuncs.com}")
    private String endpoint;

    @Override
    public void sendVerificationCode(String email, String code) {
        requireConfigured();

        Map<String, String> params = new TreeMap<>();
        params.put("AccessKeyId", accessKeyId);
        params.put("AccountName", accountName);
        params.put("Action", "SingleSendMail");
        params.put("AddressType", "1");           // 1 = 发信地址
        params.put("Format", "JSON");
        params.put("FromAlias", fromAlias);
        params.put("HtmlBody", body(code));
        params.put("ReplyToAddress", "false");
        params.put("SignatureMethod", "HMAC-SHA1");
        params.put("SignatureNonce", UUID.randomUUID().toString().replace("-", ""));
        params.put("SignatureVersion", "1.0");
        params.put("Subject", "时纪流 · 邮箱验证码");
        params.put("Timestamp", TIMESTAMP.format(clock.instant()));
        params.put("ToAddress", email);
        params.put("Version", "2015-11-23");

        String query = AliyunSmsSigner.signedQuery(params, accessKeySecret);
        URI uri = URI.create("https://" + endpoint + "/?" + query);

        HttpResponse<String> response;
        try {
            response = httpClient.send(
                    HttpRequest.newBuilder(uri).timeout(SEND_TIMEOUT).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "邮件通道调用被中断");
        } catch (IOException ex) {
            log.warn("邮件通道调用失败 email={}", mask(email), ex);
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "邮件通道不可用，请稍后重试");
        }

        String codeValue = "";
        String message = "";
        try {
            JsonNode body = objectMapper.readTree(response.body());
            codeValue = body.path("Code").asText("");
            message = body.path("Message").asText("");
        } catch (IOException ex) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "邮件通道返回了无法解析的响应");
        }
        if (!"OK".equals(codeValue)) {
            log.warn("邮件被拒 email={} code={} message={}", mask(email), codeValue, message);
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                    "邮件发送失败：" + codeValue + (message.isBlank() ? "" : " " + message));
        }
        log.info("验证码邮件已发出 email={}", mask(email));
    }

    private String body(String code) {
        return "<div style=\"font-family:sans-serif;font-size:14px;line-height:1.6\">"
                + "<p>你的验证码是：</p>"
                + "<p style=\"font-size:24px;font-weight:600;letter-spacing:2px\">" + code + "</p>"
                + "<p>10 分钟内有效。如果不是你本人操作，忽略这封邮件即可。</p>"
                + "<p style=\"color:#888\">时纪流 ChronoFlow</p></div>";
    }

    private void requireConfigured() {
        if (!StringUtils.hasText(accessKeyId) || !StringUtils.hasText(accessKeySecret)
                || !StringUtils.hasText(accountName) || !StringUtils.hasText(fromAlias)) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                    "邮件通道未配置完整（需要 access-key-id / access-key-secret / account-name / from-alias）");
        }
    }

    private String mask(String email) {
        int at = email == null ? -1 : email.indexOf('@');
        return at <= 1 ? "***" : email.charAt(0) + "***" + email.substring(at);
    }
}
