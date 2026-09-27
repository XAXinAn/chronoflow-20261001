package com.xatodo.bootstrap.config;

import com.xatodo.auth.config.AuthProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * 生产环境启动自检：拿默认值上生产就直接不启动（spec §7.1）。
 *
 * <p>为什么值得专门写一个：`application.yml` 里必须有默认值，本地两条命令就能跑起来；
 * 但也正因为有默认值，**漏配环境变量时服务会照常启动**——JWT 密钥是公开在仓库里的那串，
 * 任何人都能自己签一个管理员令牌。这类问题不会报错、不会告警，只会安静地不安全一段时间。
 * 所以这里反过来做：生产 profile 下发现用的是默认值，宁可起不来。
 *
 * <p>只在 {@code prod} profile 生效，本地开发完全不受影响（默认 profile 是 dev）。
 */
@Component
@Profile("prod")
public class ProductionSafetyCheck implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(ProductionSafetyCheck.class);

    /** 与 application.yml 里的默认值逐字一致；改了默认值这里也要跟着改。 */
    public static final String DEFAULT_JWT_SECRET =
            "xa-todo-development-secret-key-change-me-in-production";
    public static final String DEFAULT_ADMIN_PASSWORD = "admin123456";

    private final AuthProperties authProperties;
    private final String bootstrapPassword;

    public ProductionSafetyCheck(AuthProperties authProperties,
                                 @Value("${xatodo.admin.bootstrap-password:}") String bootstrapPassword) {
        this.authProperties = authProperties;
        this.bootstrapPassword = bootstrapPassword;
    }

    @Override
    public void run(ApplicationArguments args) {
        List<String> problems = new ArrayList<>();
        if (DEFAULT_JWT_SECRET.equals(authProperties.getJwtSecret())) {
            problems.add("JWT_SECRET 仍是仓库里的默认值 —— 任何人都能伪造令牌，请设置 JWT_SECRET");
        }
        if (DEFAULT_ADMIN_PASSWORD.equals(bootstrapPassword)) {
            problems.add("ADMIN_BOOTSTRAP_PASSWORD 仍是默认值 admin123456，请改成强密码");
        }
        if (authProperties.isExposeSmsCode()) {
            problems.add("xatodo.auth.expose-sms-code 在生产环境必须为 false");
        }
        if (!problems.isEmpty()) {
            String message = "生产配置自检未通过，拒绝启动：\n  - " + String.join("\n  - ", problems);
            log.error(message);
            throw new IllegalStateException(message);
        }
        log.info("生产配置自检通过（JWT 密钥与超管密码均非默认值，验证码不回显）");
    }
}
