package com.xatodo.bootstrap;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import redis.embedded.RedisServer;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 上传通道与意见反馈（spec §4.1.9 / §5.10）。
 *
 * <p>重点在几处「看起来能用、实际会出事」的地方：格式只看文件头、大小上限、
 * 静态目录免鉴权、反馈只能看到自己的、图片地址不能是外链、重复处理要幂等。
 */
@SpringBootTest
@AutoConfigureMockMvc
class SupportModuleTest {

    private static EmbeddedPostgres postgres;
    private static RedisServer redisServer;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @DynamicPropertySource
    static void dependencies(DynamicPropertyRegistry registry) throws IOException {
        postgres = EmbeddedPostgres.builder().start();
        int redisPort = findFreePort();
        redisServer = RedisServer.newRedisServer().port(redisPort).build();
        redisServer.start();
        // 上传目录指向临时目录：测试不该往工作区里写图片
        Path uploadDir = Files.createTempDirectory("xa-uploads-");

        registry.add("spring.datasource.url", () -> postgres.getJdbcUrl("postgres", "postgres"));
        registry.add("spring.datasource.username", () -> "postgres");
        registry.add("spring.datasource.password", () -> "postgres");
        registry.add("spring.data.redis.port", () -> redisPort);
        registry.add("xatodo.auth.expose-sms-code", () -> true);
        registry.add("xatodo.upload.dir", uploadDir::toString);
    }

    private static int findFreePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    @AfterAll
    static void shutdown() throws IOException {
        if (redisServer != null) {
            redisServer.stop();
        }
        if (postgres != null) {
            postgres.close();
        }
    }

    @Test
    @DisplayName("上传按文件头判定格式，不信任客户端声明的 MIME；同一张图重复上传去重")
    void uploadSniffsContentAndDeduplicates() throws Exception {
        String token = registerAccount("13800000501");

        // 声明 image/jpeg、内容却是文本——把 .exe 改名成 .jpg 就是这个形状
        byte[] notAnImage = "not an image at all".getBytes(StandardCharsets.UTF_8);
        JsonNode rejected = upload(token, "evil.jpg", MediaType.IMAGE_JPEG_VALUE, notAnImage);
        assertThat(rejected.path("code").asInt()).isEqualTo(90003);

        byte[] png = pngBytes();
        JsonNode uploaded = upload(token, "shot.png", MediaType.IMAGE_PNG_VALUE, png);
        assertThat(uploaded.path("code").asInt()).isZero();
        String url = uploaded.path("data").path("url").asText();
        assertThat(url).startsWith("/uploads/").endsWith(".png");
        assertThat(uploaded.path("data").path("contentType").asText()).isEqualTo("image/png");
        assertThat(uploaded.path("data").path("size").asLong()).isEqualTo(png.length);

        JsonNode again = upload(token, "copy.png", MediaType.IMAGE_PNG_VALUE, png);
        assertThat(again.path("data").path("url").asText()).isEqualTo(url);

        // 静态目录必须免鉴权：<Image> 直接按 URL 取图，带不了 Authorization
        byte[] served = mockMvc.perform(get(url))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsByteArray();
        assertThat(served).isEqualTo(png);
    }

    @Test
    @DisplayName("上传超过 5 MB 的图片被拒绝，且错误码与两版约定一致")
    void uploadRejectsOversizedImage() throws Exception {
        String token = registerAccount("13800000502");
        byte[] huge = new byte[5 * 1024 * 1024 + 1];
        System.arraycopy(pngBytes(), 0, huge, 0, 8);

        JsonNode json = upload(token, "huge.png", MediaType.IMAGE_PNG_VALUE, huge);

        assertThat(json.path("code").asInt()).isEqualTo(90004);
    }

    @Test
    @DisplayName("反馈提交后进入 OPEN，用户只能看到自己的")
    void feedbackIsScopedToOwnAccount() throws Exception {
        String mine = registerAccount("13800000503");
        String others = registerAccount("13800000504");

        JsonNode created = postJson("/api/v1/feedback", mine,
                "{\"category\":\"BUG\",\"content\":\"日历页周末的休/班标记有时不显示\","
                        + "\"images\":[\"/uploads/a.png\"]}");
        JsonNode data = created.path("data");
        assertThat(data.path("status").asText()).isEqualTo("OPEN");
        assertThat(data.path("images").get(0).asText()).isEqualTo("/uploads/a.png");
        // createdAt 由数据库生成：这里校验的是「从库里读回来的那条」，不是内存对象
        assertThat(data.path("createdAt").asText()).isNotEmpty();
        assertThat(data.path("handledAt").isMissingNode()).as("未处理就不该有处理时间").isTrue();

        JsonNode mineList = getJson("/api/v1/feedback", mine).path("data");
        assertThat(mineList).hasSize(1);
        assertThat(getJson("/api/v1/feedback", others).path("data")).isEmpty();
    }

    @Test
    @DisplayName("反馈的参数校验：分类非法、内容为空、图片是外链都要被挡住")
    void feedbackValidatesInput() throws Exception {
        String token = registerAccount("13800000505");

        assertThat(postRaw("/api/v1/feedback", token,
                "{\"category\":\"NOPE\",\"content\":\"x\"}").path("code").asInt()).isNotZero();
        assertThat(postRaw("/api/v1/feedback", token,
                "{\"category\":\"BUG\",\"content\":\"   \"}").path("code").asInt()).isNotZero();
        // 图片只接受本服务上传通道的相对 URL：外链等于让别人在我们的用户界面上打广告
        assertThat(postRaw("/api/v1/feedback", token,
                "{\"category\":\"BUG\",\"content\":\"x\",\"images\":[\"https://evil.example/a.png\"]}")
                .path("code").asInt()).isNotZero();
    }

    @Test
    @DisplayName("超管能查阅与处理反馈，重复处理是幂等的")
    void adminListsAndHandlesFeedback() throws Exception {
        String user = registerAccount("13800000506");
        long feedbackId = postJson("/api/v1/feedback", user,
                "{\"category\":\"SUGGESTION\",\"content\":\"希望支持把日程导出成 ics\"}")
                .path("data").path("id").asLong();
        String adminToken = adminLogin();

        JsonNode opened = getJson("/api/v1/admin/feedback", adminToken).path("data");
        assertThat(idsOf(opened)).contains(feedbackId);
        opened.forEach(item -> assertThat(item.path("status").asText()).isEqualTo("OPEN"));

        JsonNode handled = postJson("/api/v1/admin/feedback/" + feedbackId + "/handle", adminToken, "")
                .path("data");
        assertThat(handled.path("status").asText()).isEqualTo("HANDLED");
        assertThat(handled.path("handledAt").asText()).isNotEmpty();

        assertThat(idsOf(getJson("/api/v1/admin/feedback", adminToken).path("data")))
                .doesNotContain(feedbackId);
        assertThat(idsOf(getJson("/api/v1/admin/feedback?status=HANDLED", adminToken).path("data")))
                .contains(feedbackId);

        // 幂等：再点一次不报错，也不改处理时间
        JsonNode again = postJson("/api/v1/admin/feedback/" + feedbackId + "/handle", adminToken, "")
                .path("data");
        assertThat(again.path("handledAt").asText())
                .isEqualTo(handled.path("handledAt").asText());
    }

    // ------------------------------------------------------------------ 工具

    /** 最小合法 PNG 头 + 填充；服务端只按文件头判定格式。 */
    private static byte[] pngBytes() {
        byte[] content = new byte[32];
        byte[] header = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
        System.arraycopy(header, 0, content, 0, header.length);
        return content;
    }

    private JsonNode upload(String token, String fileName, String contentType, byte[] content)
            throws Exception {
        var file = new MockMultipartFile("file", fileName, contentType, content);
        String body = mockMvc.perform(multipart("/api/v1/uploads/images")
                        .file(file)
                        .header("Authorization", "Bearer " + token))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        return read(body);
    }

    private static List<Long> idsOf(JsonNode array) {
        List<Long> ids = new ArrayList<>();
        array.forEach(node -> ids.add(node.path("id").asLong()));
        return ids;
    }

    private String adminLogin() throws Exception {
        return postJson("/api/v1/admin/auth/login", null,
                "{\"username\":\"admin\",\"password\":\"admin123456\"}")
                .path("data").path("accessToken").asText();
    }

    private String registerAccount(String phone) throws Exception {
        String code = postJson("/api/v1/auth/sms/code", null, "{\"phone\":\"" + phone + "\"}")
                .path("data").path("debugCode").asText();
        String registerToken = postJson("/api/v1/auth/login/sms", null,
                "{\"phone\":\"" + phone + "\",\"code\":\"" + code + "\",\"deviceId\":\"dev\"}")
                .path("data").path("registerToken").asText();
        return postJson("/api/v1/identities/personal", registerToken,
                "{\"nickname\":\"用户" + phone.substring(phone.length() - 4) + "\",\"deviceId\":\"dev\"}")
                .path("data").path("accessToken").asText();
    }

    private JsonNode getJson(String path, String token) throws Exception {
        String body = mockMvc.perform(get(path).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8);
        return assertSuccess(read(body), path);
    }

    private JsonNode postJson(String path, String token, String body) throws Exception {
        return assertSuccess(postRaw(path, token, body), path);
    }

    /** 不校验业务成功码的提交：专门用于「应该被挡住」的用例。 */
    private JsonNode postRaw(String path, String token, String body) throws Exception {
        MockHttpServletRequestBuilder builder = post(path)
                .contentType(MediaType.APPLICATION_JSON).content(body);
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        return read(mockMvc.perform(builder).andExpect(status().isOk()).andReturn()
                .getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private JsonNode read(String body) throws Exception {
        return objectMapper.readTree(body);
    }

    private JsonNode assertSuccess(JsonNode json, String path) {
        assertThat(json.path("code").asInt())
                .withFailMessage("接口 %s 返回业务错误码 %s: %s", path,
                        json.path("code").asInt(), json.path("message").asText())
                .isZero();
        return json;
    }
}
