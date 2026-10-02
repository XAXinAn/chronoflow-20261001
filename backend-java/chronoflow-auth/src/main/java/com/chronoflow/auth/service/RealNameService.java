package com.chronoflow.auth.service;

import com.chronoflow.auth.dto.AccountSecurityDtos.RealNameInitResponse;
import com.chronoflow.auth.dto.AccountSecurityDtos.RealNameResultResponse;
import com.chronoflow.auth.sms.AliyunSmsSigner;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

/**
 * 实名认证：**阿里云 CloudAuth 金融级实人认证**（ID_PRO：姓名 + 身份证 + 人脸活体）。
 *
 * <p>与老项目（`XAXinAn/ChronoFlow` 的 `RealPersonVerificationService`）同一套服务与流程，
 * 但把「拿 certifyUrl → 客户端做人脸 → 回查结果」串成两步接口，App 用 **WebView** 打开认证页
 * （老项目走的是 Flutter 原生 SDK 桥接；RN 这边用 H5 更省事，Android/iOS 一套代码）。
 *
 * <p>**不引阿里云 SDK**：CloudAuth 与短信、邮件是同一套 RPC 签名，直接复用
 * {@link AliyunSmsSigner}（类名里的 sms 是历史，签名逻辑与业务无关）。
 *
 * <p>身份证号的处理是本类最要紧的一段：**明文只在请求体里存在一次**，随后
 * ①AES-GCM 加密（随机 IV，存 `id_card_cipher`）②HMAC 指纹（确定性，用于唯一约束）。
 * 中间态（认证还没做完）放 Redis，30 分钟过期，认证成功后立刻删掉。
 */
@Service
public class RealNameService {

    private static final Logger log = LoggerFactory.getLogger(RealNameService.class);
    private static final DateTimeFormatter TIMESTAMP =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC);
    private static final Duration CALL_TIMEOUT = Duration.ofSeconds(8);
    private static final Duration PENDING_TTL = Duration.ofMinutes(30);

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).build();
    private final Clock clock = Clock.systemUTC();
    private final SecureRandom random = new SecureRandom();
    private final StringRedisTemplate redis;
    private final AccountSecurityService accountSecurity;

    @Value("${chronoflow.auth.realname.access-key-id:}")
    private String accessKeyId;
    @Value("${chronoflow.auth.realname.access-key-secret:}")
    private String accessKeySecret;
    @Value("${chronoflow.auth.realname.endpoint:cloudauth.cn-shanghai.aliyuncs.com}")
    private String endpoint;
    @Value("${chronoflow.auth.realname.scene-id:}")
    private String sceneId;
    /** 加密与指纹的根密钥：没配就认为实名功能不可用（绝不退回默认密钥） */
    @Value("${chronoflow.auth.realname.secret:}")
    private String secret;

    public RealNameService(StringRedisTemplate redis, AccountSecurityService accountSecurity) {
        this.redis = redis;
        this.accountSecurity = accountSecurity;
    }

    /** 是否配置齐全。未配置时接口返回 90002，界面如实说「暂不可用」。 */
    public boolean configured() {
        return StringUtils.hasText(accessKeyId) && StringUtils.hasText(accessKeySecret)
                && StringUtils.hasText(sceneId) && StringUtils.hasText(secret);
    }

    /** 第一步：换认证页地址。姓名 / 身份证只用于这一次调用和我们自己的加密存储。 */
    public RealNameInitResponse init(Long accountId, String realName, String idCardNumber) {
        requireConfigured();
        String normalizedId = idCardNumber.trim().toUpperCase();
        String certifyId;
        String certifyUrl;
        try {
            Map<String, String> params = baseParams("InitFaceVerify");
            params.put("CertName", realName.trim());
            params.put("CertNo", normalizedId);
            params.put("CertType", "IDENTITY_CARD");
            params.put("Model", "LIVENESS");
            params.put("ProductCode", "ID_PRO");
            params.put("OuterOrderNo", "u" + accountId + "-" + UUID.randomUUID().toString().replace("-", ""));
            params.put("SceneId", sceneId);
            params.put("UserId", String.valueOf(accountId));
            params.put("MetaInfo", "{\"zimVer\":\"3.0.0\",\"appVersion\":\"1.0\"}");
            JsonNode result = call(params, "ResultObject");
            certifyId = result.path("CertifyId").asText("");
            certifyUrl = result.path("CertifyUrl").asText("");
        } catch (BizException ex) {
            throw ex;
        } catch (RuntimeException ex) {
            log.warn("实人认证 InitFaceVerify 失败 accountId={}", accountId, ex);
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "实名认证服务暂时不可用，请稍后重试");
        }
        if (!StringUtils.hasText(certifyId) || !StringUtils.hasText(certifyUrl)) {
            /*
             * 这一步踩过一个真坑（2026-10-02）：**场景类型要匹配接入方式**。
             *
             * CloudAuth 的场景分「App 端 SDK」和「Web/H5」两类：前者只返回 `CertifyId`（人脸由客户端 SDK
             * 完成），后者才返回 `CertifyUrl`（我们 App 用 WebView 打开它）。拿一个 SDK 场景去要网页地址，
             * 阿里云照样回 200，只是 `ResultObject` 里**只有 CertifyId**——于是这里会抛「没有返回认证地址」，
             * 看着像服务挂了，其实是场景类型不对。
             */
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                    "实名认证场景类型不匹配：当前 SceneId 没有返回网页版认证地址（需要在阿里云实人认证控制台"
                            + "新建一个「网页/H5」场景，并把它的 SceneId 配到服务端）");
        }
        // 认证还没做完：把姓名/身份证密文/指纹暂存，回查通过时再落库（30 分钟不完成就作废）
        redis.opsForValue().set(pendingKey(certifyId),
                realName.trim() + "\n" + encrypt(normalizedId) + "\n" + fingerprint(normalizedId),
                PENDING_TTL);
        return new RealNameInitResponse(certifyId, certifyUrl);
    }

    /** 第二步：人脸做完后回查结果；通过才落库。 */
    public RealNameResultResponse result(Long accountId, String certifyId) {
        requireConfigured();
        String pending = redis.opsForValue().get(pendingKey(certifyId));
        if (pending == null) {
            // 过期 / 伪造的 certifyId：不假装成功，也不泄露它是不是真的存在过
            return new RealNameResultResponse(false, "认证已超时，请重新发起");
        }
        Map<String, String> params = baseParams("DescribeFaceVerify");
        params.put("CertifyId", certifyId);
        params.put("SceneId", sceneId);
        JsonNode result = call(params, "ResultObject");
        if (!"T".equalsIgnoreCase(result.path("Passed").asText(""))) {
            return new RealNameResultResponse(false, result.path("SubCode").asText("认证未通过"));
        }
        String[] parts = pending.split("\n");
        accountSecurity.saveVerifiedRealName(accountId, parts[0], parts[1], parts[2]);
        redis.delete(pendingKey(certifyId));
        log.info("实名认证通过 accountId={}", accountId);
        return new RealNameResultResponse(true, null);
    }

    // ------------------------------------------------------------------ 内部工具

    private Map<String, String> baseParams(String action) {
        Map<String, String> params = new TreeMap<>();
        params.put("AccessKeyId", accessKeyId);
        params.put("Action", action);
        params.put("Format", "JSON");
        params.put("RegionId", "cn-shanghai");
        params.put("SignatureMethod", "HMAC-SHA1");
        params.put("SignatureNonce", UUID.randomUUID().toString().replace("-", ""));
        params.put("SignatureVersion", "1.0");
        params.put("Timestamp", TIMESTAMP.format(clock.instant()));
        params.put("Version", "2019-03-07");
        return params;
    }

    private JsonNode call(Map<String, String> params, String objectField) {
        String query = AliyunSmsSigner.signedQuery(params, accessKeySecret);
        URI uri = URI.create("https://" + endpoint + "/?" + query);
        HttpResponse<String> response;
        try {
            response = httpClient.send(
                    HttpRequest.newBuilder(uri).timeout(CALL_TIMEOUT).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "实名认证调用被中断");
        } catch (IOException ex) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "实名认证服务不可用，请稍后重试");
        }
        JsonNode body;
        try {
            body = objectMapper.readTree(response.body());
        } catch (IOException ex) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE, "实名认证服务返回了无法解析的响应");
        }
        if (!"200".equals(body.path("Code").asText(""))) {
            String message = body.path("Message").asText("");
            log.warn("实名认证被拒 code={} message={}", body.path("Code").asText(""), message);
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                    "实名认证失败：" + (message.isBlank() ? body.path("Code").asText("") : message));
        }
        return body.path(objectField);
    }

    private void requireConfigured() {
        if (!configured()) {
            throw BizException.of(ErrorCode.THIRD_PARTY_UNAVAILABLE,
                    "实名认证暂不可用（服务端未配置 CloudAuth）");
        }
    }

    /** 身份证密文：AES-GCM，随机 IV 前置。随机 IV 是刻意的——同样的身份证号不会产生同样的密文。 */
    private String encrypt(String plain) {
        try {
            byte[] iv = new byte[12];
            random.nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, aesKey(), new GCMParameterSpec(128, iv));
            byte[] encrypted = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + encrypted.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(encrypted, 0, out, iv.length, encrypted.length);
            return Base64.getEncoder().encodeToString(out);
        } catch (Exception ex) {
            throw BizException.of(ErrorCode.INTERNAL_ERROR, "身份证加密失败");
        }
    }

    /** 指纹：HMAC-SHA256 的十六进制。用来做唯一约束（密文带随机 IV，没法比对）。 */
    private String fingerprint(String idCardNumber) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(deriveKey("fingerprint"), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(idCardNumber.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw BizException.of(ErrorCode.INTERNAL_ERROR, "身份证指纹计算失败");
        }
    }

    private SecretKeySpec aesKey() {
        return new SecretKeySpec(deriveKey("aes"), "AES");
    }

    /** 从同一个根密钥派生出两把互不相干的密钥（域分隔），避免「一把钥匙到处用」。 */
    private byte[] deriveKey(String purpose) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return digest.digest((purpose + ":" + secret).getBytes(StandardCharsets.UTF_8));
        } catch (Exception ex) {
            throw BizException.of(ErrorCode.INTERNAL_ERROR, "密钥派生失败");
        }
    }

    private String pendingKey(String certifyId) {
        return "realname:pending:" + certifyId;
    }
}
