package com.xatodo.auth.store.redis;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.xatodo.auth.store.RefreshTokenRecord;
import com.xatodo.auth.store.RefreshTokenStore;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ZSetOperations;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.Optional;
import java.util.Set;

/**
 * 基于 Redis 的刷新令牌存储。
 *
 * <p>令牌记录存 {@code rt:{tokenId}}，身份索引为 ZSET {@code rt:idx:{identityId}}，
 * 以签发时间戳为 score，便于实施「单身份最多 5 台设备」的踢除策略（spec §3.5）。
 */
@Component
public class RedisRefreshTokenStore implements RefreshTokenStore {

    private static final String TOKEN_KEY = "rt:";
    private static final String INDEX_IDENTITY = "rt:idx:i:";
    private static final String INDEX_ACCOUNT = "rt:idx:a:";
    private static final String SUCCESSOR_KEY = "rt:succ:";

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;

    public RedisRefreshTokenStore(StringRedisTemplate redis, ObjectMapper objectMapper) {
        this.redis = redis;
        this.objectMapper = objectMapper;
    }

    @Override
    public void save(RefreshTokenRecord record, Duration ttl) {
        redis.opsForValue().set(TOKEN_KEY + record.tokenId(), serialize(record), ttl);
        long score = record.issuedAt().toEpochMilli();
        redis.opsForZSet().add(INDEX_IDENTITY + record.identityId(), record.tokenId(), score);
        redis.expire(INDEX_IDENTITY + record.identityId(), ttl);
        redis.opsForZSet().add(INDEX_ACCOUNT + record.accountId(), record.tokenId(), score);
        redis.expire(INDEX_ACCOUNT + record.accountId(), ttl);
    }

    @Override
    public Optional<RefreshTokenRecord> find(String tokenId) {
        String json = redis.opsForValue().get(TOKEN_KEY + tokenId);
        if (json == null) {
            return Optional.empty();
        }
        try {
            return Optional.of(objectMapper.readValue(json, RefreshTokenRecord.class));
        } catch (JsonProcessingException ex) {
            throw BizException.of(ErrorCode.REFRESH_TOKEN_INVALID);
        }
    }

    @Override
    public void delete(String tokenId) {
        Optional<RefreshTokenRecord> record = find(tokenId);
        redis.delete(TOKEN_KEY + tokenId);
        record.ifPresent(value -> {
            redis.opsForZSet().remove(INDEX_IDENTITY + value.identityId(), tokenId);
            redis.opsForZSet().remove(INDEX_ACCOUNT + value.accountId(), tokenId);
        });
    }

    @Override
    public void deleteAllForIdentity(Long identityId) {
        String indexKey = INDEX_IDENTITY + identityId;
        forEachIndexedToken(indexKey, (tokenId, record) ->
                redis.opsForZSet().remove(INDEX_ACCOUNT + record.accountId(), tokenId));
        redis.delete(indexKey);
    }

    @Override
    public void deleteAllForAccount(Long accountId) {
        String indexKey = INDEX_ACCOUNT + accountId;
        forEachIndexedToken(indexKey, (tokenId, record) ->
                redis.opsForZSet().remove(INDEX_IDENTITY + record.identityId(), tokenId));
        redis.delete(indexKey);
    }

    @Override
    public void saveSuccessor(String previousTokenId, String newTokenId, Duration grace) {
        if (grace == null || grace.isZero() || grace.isNegative()) {
            return;
        }
        redis.opsForValue().set(SUCCESSOR_KEY + previousTokenId, newTokenId, grace);
    }

    @Override
    public Optional<String> findSuccessor(String previousTokenId) {
        return Optional.ofNullable(redis.opsForValue().get(SUCCESSOR_KEY + previousTokenId));
    }

    @Override
    public void enforceDeviceLimit(Long identityId, int maxDevices) {
        String indexKey = INDEX_IDENTITY + identityId;
        Long size = redis.opsForZSet().zCard(indexKey);
        while (size != null && size > maxDevices) {
            Set<ZSetOperations.TypedTuple<String>> oldest =
                    redis.opsForZSet().rangeWithScores(indexKey, 0, 0);
            if (oldest == null || oldest.isEmpty()) {
                break;
            }
            String tokenId = oldest.iterator().next().getValue();
            Optional<RefreshTokenRecord> evicted = find(tokenId);
            redis.delete(TOKEN_KEY + tokenId);
            evicted.ifPresent(record ->
                    redis.opsForZSet().remove(INDEX_ACCOUNT + record.accountId(), tokenId));
            redis.opsForZSet().remove(indexKey, tokenId);
            size = redis.opsForZSet().zCard(indexKey);
        }
    }

    /**
     * 遍历索引中的令牌：先读取记录再删除，避免删除后无法得知其归属索引。
     */
    private void forEachIndexedToken(String indexKey, java.util.function.BiConsumer<String, RefreshTokenRecord> onRecord) {
        Set<String> tokenIds = redis.opsForZSet().range(indexKey, 0, -1);
        if (tokenIds == null || tokenIds.isEmpty()) {
            return;
        }
        for (String tokenId : tokenIds) {
            find(tokenId).ifPresent(record -> onRecord.accept(tokenId, record));
            redis.delete(TOKEN_KEY + tokenId);
        }
    }

    private String serialize(RefreshTokenRecord record) {
        try {
            return objectMapper.writeValueAsString(record);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("刷新令牌序列化失败", ex);
        }
    }
}
