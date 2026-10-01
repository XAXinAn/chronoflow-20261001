package com.chronoflow.auth.store;

import java.time.Duration;
import java.util.Optional;

/**
 * 短信验证码存储：验证码、发送频控锁与日限额计数。
 */
public interface VerificationCodeStore {

    void saveCode(String phone, String code, Duration ttl);

    Optional<String> findCode(String phone);

    void deleteCode(String phone);

    /**
     * 尝试获取发送锁，成功返回 true。用于「同手机号 60 秒 1 条」频控。
     */
    boolean tryAcquireSendLock(String phone, Duration ttl);

    /**
     * 释放发送锁。**只在短信真的没发出去时用**：否则用户被 60 秒频控锁住，
     * 却连一次验证码都没收到。
     */
    void releaseSendLock(String phone);

    /**
     * 递增日计数并返回递增后的值。dimension 取 {@code phone} 或 {@code ip}。
     */
    long incrementDailyCount(String dimension, String value, Duration ttl);

    /**
     * 记录一次校验失败次数并返回当前失败次数。
     */
    long incrementVerifyFailure(String phone, Duration ttl);

    void clearVerifyFailure(String phone);
}
