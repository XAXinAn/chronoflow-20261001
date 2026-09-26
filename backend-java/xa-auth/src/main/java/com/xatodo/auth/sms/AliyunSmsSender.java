package com.xatodo.auth.sms;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.xatodo.auth.config.AuthProperties;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
import java.util.Map;
import java.util.UUID;

/**
 * 阿里云短信通道（spec §3.6）。
 *
 * <p>只在 {@code xatodo.auth.sms.provider=aliyun} 时装配；配置不完整直接报错而不是静默降级——
 * 「以为发了短信，其实一条没发」是登录流程里最坑的失败方式。
 */
@Component
@ConditionalOnProperty(name = "xatodo.auth.sms.provider", havingValue = "aliyun")
public class AliyunSmsSender implements SmsSender {

    private static final Logger log = LoggerFactory.getLogger(AliyunSmsSender.class);
    private static final Duration SEND_TIMEOUT = Duration.ofSeconds(8);

    private final AuthProperties.Sms config;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;
    private final Clock clock;

    public AliyunSmsSender(AuthProperties properties, ObjectMapper objectMapper) {
        this(properties, objectMapper,
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build(),
                Clock.systemUTC());
    }

    /** 便于测试注入固定时钟与假 HttpClient。 */
    AliyunSmsSender(AuthProperties properties,
                    ObjectMapper objectMapper,
                    HttpClient httpClient,
                    Clock clock) {
        this.config = properties.getSms();
        this.objectMapper = objectMapper;
        this.httpClient = httpClient;
        this.clock = clock;
    }

    @Override
    public void sendVerificationCode(String phone, String code) {
        requireConfigured();

        Map<String, String> params = AliyunSmsSigner.sendSmsParams(
                config.getAccessKeyId(), phone, config.getSignName(), config.getTemplateCode(),
                // 模板变量名与组织既有短信模板保持一致（{"code":"123456"}）
                "{\"code\":\"" + code + "\"}",
                UUID.randomUUID().toString().replace("-", ""), clock.instant(), config.getRegionId());
        String query = AliyunSmsSigner.signedQuery(params, config.getAccessKeySecret());
        URI uri = URI.create("https://" + config.getEndpoint() + "/?" + query);

        HttpResponse<String> response;
        try {
            response = httpClient.send(
                    HttpRequest.newBuilder(uri).timeout(SEND_TIMEOUT).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "短信通道调用被中断");
        } catch (IOException ex) {
            log.warn("短信通道调用失败 phone={}", mask(phone), ex);
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "短信通道不可用，请稍后重试");
        }

        String resultCode;
        String resultMessage;
        try {
            JsonNode body = objectMapper.readTree(response.body());
            resultCode = body.path("Code").asText("");
            resultMessage = body.path("Message").asText("");
        } catch (IOException ex) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "短信通道返回了无法解析的响应");
        }
        if (!"OK".equals(resultCode)) {
            log.warn("短信发送被拒 phone={} code={} message={}", mask(phone), resultCode, resultMessage);
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                    "短信发送失败：" + resultCode + (resultMessage.isBlank() ? "" : " " + resultMessage));
        }
        log.info("验证码短信已发出 phone={}", mask(phone));
    }

    private void requireConfigured() {
        if (!StringUtils.hasText(config.getAccessKeyId())
                || !StringUtils.hasText(config.getAccessKeySecret())
                || !StringUtils.hasText(config.getSignName())
                || !StringUtils.hasText(config.getTemplateCode())) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                    "短信通道未配置完整（需要 access-key-id / access-key-secret / sign-name / template-code）");
        }
    }

    private String mask(String phone) {
        return phone != null && phone.length() >= 7
                ? phone.substring(0, 3) + "****" + phone.substring(phone.length() - 4)
                : "***";
    }
}
