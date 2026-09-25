package com.xatodo.admin.config;

import com.xatodo.admin.entity.AdminUser;
import com.xatodo.admin.mapper.AdminUserMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

/**
 * 首次启动时创建初始超级管理员，避免出现「没有任何人能登录后台」的死锁状态。
 *
 * <p>仅在 admin_user 表为空时执行；生产环境务必通过环境变量覆盖初始密码。
 */
@Component
public class AdminUserInitializer implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(AdminUserInitializer.class);

    private final AdminUserMapper adminUserMapper;
    private final PasswordEncoder passwordEncoder;

    @Value("${xatodo.admin.bootstrap-username:admin}")
    private String bootstrapUsername;

    @Value("${xatodo.admin.bootstrap-password:admin123456}")
    private String bootstrapPassword;

    public AdminUserInitializer(AdminUserMapper adminUserMapper, PasswordEncoder passwordEncoder) {
        this.adminUserMapper = adminUserMapper;
        this.passwordEncoder = passwordEncoder;
    }

    @Override
    public void run(ApplicationArguments args) {
        Long count = adminUserMapper.selectCount(null);
        if (count != null && count > 0) {
            return;
        }
        AdminUser admin = new AdminUser();
        admin.setUsername(bootstrapUsername);
        admin.setPasswordHash(passwordEncoder.encode(bootstrapPassword));
        admin.setRealName("平台超管");
        admin.setRole(AdminUser.ROLE_SUPER_ADMIN);
        admin.setMfaEnabled(false);
        admin.setStatus(AdminUser.STATUS_ACTIVE);
        admin.setFailedLoginCount(0);
        adminUserMapper.insert(admin);
        log.warn("已创建初始超级管理员 [{}]，请立即登录后台修改密码", bootstrapUsername);
    }
}
