package com.chronoflow.auth.store.redis;

import com.chronoflow.auth.store.AccountRevocationStore;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;

/**
 * 基于 Redis 的账号作废标记。
 *
 * <p>用「有过期时间的键」而不是一张表：这个标记只需要活到**最后一张已签发的访问令牌过期为止**，
 * 之后自然就没有意义了。Redis 的 TTL 正好表达这件事，也避免了清理任务。
 */
@Component
public class RedisAccountRevocationStore implements AccountRevocationStore {

    private static final String KEY_PREFIX = "revoked:acct:";

    private final StringRedisTemplate redis;

    public RedisAccountRevocationStore(StringRedisTemplate redis) {
        this.redis = redis;
    }

    @Override
    public void revoke(Long accountId, Duration ttl) {
        redis.opsForValue().set(KEY_PREFIX + accountId, "1", ttl);
    }

    @Override
    public boolean isRevoked(Long accountId) {
        return Boolean.TRUE.equals(redis.hasKey(KEY_PREFIX + accountId));
    }
}
