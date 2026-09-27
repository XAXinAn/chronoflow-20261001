package com.xatodo.bootstrap;

import com.xatodo.auth.config.AuthProperties;
import com.xatodo.bootstrap.config.ProductionSafetyCheck;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 生产配置自检（spec §7.1）。
 *
 * <p>这不是「测一个方法」——它钉的是一条**上线节奏**：默认值绝不允许上生产。
 * 漏配环境变量时服务照常启动、JWT 密钥是仓库里公开的那串，这类问题不报错也不告警，
 * 只会安静地不安全，所以必须有测试守着「发现默认值就拒绝启动」。
 */
class ProductionSafetyCheckTest {

    private static AuthProperties properties(String jwtSecret, boolean exposeSmsCode) {
        AuthProperties props = new AuthProperties();
        props.setJwtSecret(jwtSecret);
        props.setExposeSmsCode(exposeSmsCode);
        return props;
    }

    @Test
    @DisplayName("默认 JWT 密钥 + 默认超管密码 → 拒绝启动")
    void refusesToStartWithDefaults() {
        ProductionSafetyCheck check = new ProductionSafetyCheck(
                properties(ProductionSafetyCheck.DEFAULT_JWT_SECRET, false),
                ProductionSafetyCheck.DEFAULT_ADMIN_PASSWORD);

        assertThatThrownBy(() -> check.run(null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET")
                .hasMessageContaining("ADMIN_BOOTSTRAP_PASSWORD");
    }

    @Test
    @DisplayName("生产环境把验证码回显打开也算配置错误")
    void refusesWhenSmsCodeIsEchoed() {
        ProductionSafetyCheck check = new ProductionSafetyCheck(
                properties("a-real-secret-of-sufficient-length-0000000000", true),
                "a-real-password");

        assertThatThrownBy(() -> check.run(null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("expose-sms-code");
    }

    @Test
    @DisplayName("配齐了就可以启动")
    void passesWithRealSecrets() {
        ProductionSafetyCheck check = new ProductionSafetyCheck(
                properties("a-real-secret-of-sufficient-length-0000000000", false),
                "a-real-password");

        assertThatCode(() -> check.run(null)).doesNotThrowAnyException();
        assertThat(ProductionSafetyCheck.DEFAULT_JWT_SECRET)
                .as("默认密钥常量必须与 application.yml 里的默认值一致，改一处要改两处")
                .isNotBlank();
    }
}
