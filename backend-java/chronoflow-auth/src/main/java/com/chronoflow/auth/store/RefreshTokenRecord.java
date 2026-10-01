package com.chronoflow.auth.store;

import java.time.Instant;

/**
 * 刷新令牌记录。令牌本体不落库，仅存随机串的哈希与归属关系（spec §3.5）。
 */
public record RefreshTokenRecord(String tokenId,
                                 Long accountId,
                                 Long identityId,
                                 String deviceId,
                                 Instant issuedAt) {
}
