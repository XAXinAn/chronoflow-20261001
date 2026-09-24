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
    private static final String INDEX_KEY = "rt:idx:";

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;

    public RedisRefreshTokenStore(StringRedisTemplate redis, ObjectMapper objectMapper) {
        this.redis = redis;
        this.objectMapper = objectMapper;
    }

    @Override
    public void save(RefreshTokenRecord record, Duration ttl) {
        redis.opsForValue().set(TOKEN_KEY + record.tokenId(), serialize(record), ttl);
        redis.opsForZSet().add(INDEX_KEY + record.identityId(),
                record.tokenId(), record.issuedAt().toEpochMilli());
        redis.expire(INDEX_KEY + record.identityId(), ttl);
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
        record.ifPresent(value -> redis.opsForZSet().remove(INDEX_KEY + value.identityId(), tokenId));
    }

    @Override
    public void deleteAllForIdentity(Long identityId) {
        Set<String> tokenIds = redis.opsForZSet().range(INDEX_KEY + identityId, 0, -1);
        if (tokenIds != null && !tokenIds.isEmpty()) {
            redis.delete(tokenIds.stream().map(id -> TOKEN_KEY + id).toList());
        }
        redis.delete(INDEX_KEY + identityId);
    }

    @Override
    public void enforceDeviceLimit(Long identityId, int maxDevices) {
        String indexKey = INDEX_KEY + identityId;
        Long size = redis.opsForZSet().zCard(indexKey);
        while (size != null && size > maxDevices) {
            Set<ZSetOperations.TypedTuple<String>> oldest =
                    redis.opsForZSet().rangeWithScores(indexKey, 0, 0);
            if (oldest == null || oldest.isEmpty()) {
                break;
            }
            String tokenId = oldest.iterator().next().getValue();
            redis.delete(TOKEN_KEY + tokenId);
            redis.opsForZSet().remove(indexKey, tokenId);
            size = redis.opsForZSet().zCard(indexKey);
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
