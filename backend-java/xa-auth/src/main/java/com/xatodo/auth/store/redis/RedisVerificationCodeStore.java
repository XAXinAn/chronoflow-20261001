package com.xatodo.auth.store.redis;

import com.xatodo.auth.store.VerificationCodeStore;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.Optional;

/**
 * 基于 Redis 的验证码存储，键规范见 spec §3.6。
 */
@Component
public class RedisVerificationCodeStore implements VerificationCodeStore {

    private static final String CODE_KEY = "sms:code:";
    private static final String LOCK_KEY = "sms:lock:";
    private static final String DAILY_KEY = "sms:daily:";
    private static final String FAIL_KEY = "sms:fail:";

    private final StringRedisTemplate redis;

    public RedisVerificationCodeStore(StringRedisTemplate redis) {
        this.redis = redis;
    }

    @Override
    public void saveCode(String phone, String code, Duration ttl) {
        redis.opsForValue().set(CODE_KEY + phone, code, ttl);
    }

    @Override
    public Optional<String> findCode(String phone) {
        return Optional.ofNullable(redis.opsForValue().get(CODE_KEY + phone));
    }

    @Override
    public void deleteCode(String phone) {
        redis.delete(CODE_KEY + phone);
    }

    @Override
    public boolean tryAcquireSendLock(String phone, Duration ttl) {
        Boolean acquired = redis.opsForValue().setIfAbsent(LOCK_KEY + phone, "1", ttl);
        return Boolean.TRUE.equals(acquired);
    }

    @Override
    public void releaseSendLock(String phone) {
        redis.delete(LOCK_KEY + phone);
    }

    @Override
    public long incrementDailyCount(String dimension, String value, Duration ttl) {
        String key = DAILY_KEY + dimension + ":" + value;
        Long count = redis.opsForValue().increment(key);
        long current = count == null ? 0L : count;
        if (current == 1L) {
            redis.expire(key, ttl);
        }
        return current;
    }

    @Override
    public long incrementVerifyFailure(String phone, Duration ttl) {
        String key = FAIL_KEY + phone;
        Long count = redis.opsForValue().increment(key);
        long current = count == null ? 0L : count;
        if (current == 1L) {
            redis.expire(key, ttl);
        }
        return current;
    }

    @Override
    public void clearVerifyFailure(String phone) {
        redis.delete(FAIL_KEY + phone);
    }
}
