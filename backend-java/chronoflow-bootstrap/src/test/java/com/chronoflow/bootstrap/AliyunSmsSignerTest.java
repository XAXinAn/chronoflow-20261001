package com.chronoflow.bootstrap;

import com.chronoflow.auth.sms.AliyunSmsSigner;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 阿里云短信签名的纯逻辑测试（spec §3.6）。
 *
 * <p>签名错了的表现是「接口返回 400 SignatureDoesNotMatch」——那是线上才会发现的失败方式，
 * 所以这里用一组固定参数把规范查询串与签名值钉死；期望值由独立的 Python 实现算出（不是抄 Java 的输出）。
 */
class AliyunSmsSignerTest {

    private static final String EXPECTED_QUERY = "AccessKeyId=testKey&Action=SendSms&Format=JSON"
            + "&PhoneNumbers=13800000000&RegionId=cn-hangzhou"
            + "&SignName=%E6%B5%8B%E8%AF%95%E7%AD%BE%E5%90%8D"
            + "&SignatureMethod=HMAC-SHA1&SignatureNonce=abc123&SignatureVersion=1.0"
            + "&TemplateCode=SMS_123"
            + "&TemplateParam=%7B%22code%22%3A%22123456%22%7D"
            + "&Timestamp=2026-09-26T10%3A00%3A00Z&Version=2017-05-25";
    private static final String EXPECTED_SIGNATURE = "d3xjBNHYOq/U2adKkM9vTiIS7AA=";

    @Test
    @DisplayName("规范化查询串：按 key 排序、空格编成 %20、中文与 JSON 都按 UTF-8 编码")
    void canonicalQueryMatchesAliyunRules() {
        Map<String, String> params = AliyunSmsSigner.sendSmsParams(
                "testKey", "13800000000", "测试签名", "SMS_123",
                "{\"code\":\"123456\"}", "abc123",
                Instant.parse("2026-09-26T10:00:00Z"), "cn-hangzhou");

        assertThat(AliyunSmsSigner.canonicalQuery(params)).isEqualTo(EXPECTED_QUERY);
        assertThat(AliyunSmsSigner.sign("testSecret", EXPECTED_QUERY)).isEqualTo(EXPECTED_SIGNATURE);
    }

    @Test
    @DisplayName("百分号编码：~ 不编码，空格是 %20 而不是 +，* 不能漏")
    void percentEncodeFollowsRfc3986() {
        assertThat(AliyunSmsSigner.percentEncode("a b")).isEqualTo("a%20b");
        assertThat(AliyunSmsSigner.percentEncode("a+b")).isEqualTo("a%2Bb");
        assertThat(AliyunSmsSigner.percentEncode("a*b~c-d_e.f")).isEqualTo("a%2Ab~c-d_e.f");
    }

    @Test
    @DisplayName("最终查询串末尾带上编码后的 Signature")
    void signedQueryAppendsSignature() {
        Map<String, String> params = AliyunSmsSigner.sendSmsParams(
                "testKey", "13800000000", "测试签名", "SMS_123",
                "{\"code\":\"123456\"}", "abc123",
                Instant.parse("2026-09-26T10:00:00Z"), "cn-hangzhou");

        String query = AliyunSmsSigner.signedQuery(params, "testSecret");
        assertThat(query).startsWith(EXPECTED_QUERY + "&Signature=");
        assertThat(query).endsWith(AliyunSmsSigner.percentEncode(EXPECTED_SIGNATURE));
    }
}
