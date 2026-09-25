package com.xatodo.auth.store;

import java.time.Duration;
import java.util.Optional;
import java.util.List;

/**
 * 刷新令牌存储。首版基于 Redis 实现。
 */
public interface RefreshTokenStore {

    void save(RefreshTokenRecord record, Duration ttl);

    Optional<RefreshTokenRecord> find(String tokenId);

    void delete(String tokenId);

    void deleteAllForIdentity(Long identityId);

    void deleteAllForAccount(Long accountId);

    /**
     * 记录「旧令牌 → 新令牌」的轮换关系，在宽限期内允许复用旧令牌取回同一新令牌。
     */
    void saveSuccessor(String previousTokenId, String newTokenId, Duration grace);

    Optional<String> findSuccessor(String previousTokenId);

    /** 某身份下全部活跃设备（按签发时间升序）。 */
    List<RefreshTokenRecord> listForIdentity(Long identityId);

    /** 按设备标识查找该身份的会话。 */
    Optional<RefreshTokenRecord> findByDevice(Long identityId, String deviceId);

    /**
     * 保证同一身份的活跃设备数不超过上限，超出时踢除最早签发的令牌。
     */
    void enforceDeviceLimit(Long identityId, int maxDevices);
}
