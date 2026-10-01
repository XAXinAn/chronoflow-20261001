package com.chronoflow.auth.store;

import java.time.Duration;

/**
 * 「这个账号的访问令牌全部作废」的标记。
 *
 * <p>为什么需要它：访问令牌是无状态 JWT，签发后有效期 2 小时。吊销刷新令牌只能阻止**续期**，
 * 已经签发出去的 access token 在此期间仍然可用——于是「账号刚被注销，却还能再写两条日程」。
 * 这既有安全风险，也和隐私政策里写的「注销立即生效」不符。
 *
 * <p>做法是把「已作废的账号」记在 Redis 里（TTL = 访问令牌有效期，过期自动清理，不会无限增长），
 * 鉴权过滤器解析出 JWT 后再看一眼这个标记。
 *
 * <p>代价是每个已认证请求多一次 Redis 查询。对一个已经在用 Redis 存刷新令牌与验证码的服务来说，
 * 这个代价可以接受；换来的是「停用 / 注销**立即**生效」，而不是最多 2 小时的窗口。
 */
public interface AccountRevocationStore {

    /** 把某账号的全部访问令牌标记为作废，ttl 取访问令牌的剩余最长有效期即可。 */
    void revoke(Long accountId, Duration ttl);

    boolean isRevoked(Long accountId);
}
