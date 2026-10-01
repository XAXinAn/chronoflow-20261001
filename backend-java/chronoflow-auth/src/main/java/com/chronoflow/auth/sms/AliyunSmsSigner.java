package com.chronoflow.auth.sms;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Collectors;

/**
 * 阿里云短信（dysmsapi 2017-05-25）的 RPC 请求签名，spec §3.6。
 *
 * <p>刻意**不引 SDK**：官方 SDK 会带进阿里云整套 tea 依赖，而这里只需要
 * 「一组参数 + HMAC-SHA1 签名」。抽成纯函数还有个好处——签名是离线可测的，
 * 不用真的发一条短信才知道对不对。
 */
public final class AliyunSmsSigner {

    private static final DateTimeFormatter TIMESTAMP =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC);

    private AliyunSmsSigner() {
    }

    /** SendSms 的全部公共参数（含 Timestamp / SignatureNonce，键已排序）。 */
    public static Map<String, String> sendSmsParams(String accessKeyId,
                                                    String phoneNumbers,
                                                    String signName,
                                                    String templateCode,
                                                    String templateParam,
                                                    String signatureNonce,
                                                    Instant timestamp,
                                                    String regionId) {
        Map<String, String> params = new TreeMap<>();
        params.put("AccessKeyId", accessKeyId);
        params.put("Action", "SendSms");
        params.put("Format", "JSON");
        params.put("PhoneNumbers", phoneNumbers);
        params.put("RegionId", regionId);
        params.put("SignName", signName);
        params.put("SignatureMethod", "HMAC-SHA1");
        params.put("SignatureNonce", signatureNonce);
        params.put("SignatureVersion", "1.0");
        params.put("TemplateCode", templateCode);
        params.put("TemplateParam", templateParam);
        params.put("Timestamp", TIMESTAMP.format(timestamp));
        params.put("Version", "2017-05-25");
        return params;
    }

    /** 规范化查询串：按 key 排序，key/value 都做 RFC3986 编码。 */
    public static String canonicalQuery(Map<String, String> params) {
        return params.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(entry -> percentEncode(entry.getKey()) + "=" + percentEncode(entry.getValue()))
                .collect(Collectors.joining("&"));
    }

    /** 签名串 = {@code GET&%2F&<编码后的规范查询串>}，再对 {@code secret + "&"} 做 HMAC-SHA1。 */
    public static String sign(String accessKeySecret, String canonicalQuery) {
        String stringToSign = "GET&" + percentEncode("/") + "&" + percentEncode(canonicalQuery);
        try {
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec((accessKeySecret + "&").getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
            return Base64.getEncoder().encodeToString(mac.doFinal(stringToSign.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException("阿里云短信签名失败", ex);
        }
    }

    /** 最终查询串：规范查询串 + 末尾带上的 Signature。 */
    public static String signedQuery(Map<String, String> params, String accessKeySecret) {
        String canonical = canonicalQuery(params);
        return canonical + "&Signature=" + percentEncode(sign(accessKeySecret, canonical));
    }

    /**
     * RFC3986 百分号编码。
     *
     * <p>注意两处与 {@code URLEncoder} 不同：空格是 {@code %20} 而不是 {@code +}，
     * {@code *} 也要编码成 {@code %2A}；{@code ~} 不编码。
     */
    public static String percentEncode(String value) {
        StringBuilder encoded = new StringBuilder();
        for (byte raw : value.getBytes(StandardCharsets.UTF_8)) {
            char ch = (char) (raw & 0xFF);
            if (isUnreserved(ch)) {
                encoded.append(ch);
            } else {
                encoded.append('%').append(String.format("%02X", raw & 0xFF));
            }
        }
        return encoded.toString();
    }

    private static boolean isUnreserved(char ch) {
        return (ch >= 'A' && ch <= 'Z')
                || (ch >= 'a' && ch <= 'z')
                || (ch >= '0' && ch <= '9')
                || ch == '-' || ch == '_' || ch == '.' || ch == '~';
    }
}
