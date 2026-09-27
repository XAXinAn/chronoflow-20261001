package com.xatodo.auth.service;

import com.xatodo.auth.config.AuthProperties;
import com.xatodo.auth.security.IdentityPrincipal;
import com.xatodo.auth.security.TokenScope;
import com.xatodo.auth.store.RefreshTokenRecord;
import com.xatodo.auth.store.RefreshTokenStore;
import com.xatodo.auth.store.AccountRevocationStore;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.Optional;
import java.util.List;
import java.util.UUID;

/**
 * 令牌签发与校验。访问令牌为 JWT，刷新令牌为随机串并存于 Redis（spec §3.5）。
 */
@Service
public class TokenService {

    private static final String CLAIM_SCOPE = "scope";
    private static final String CLAIM_IDENTITY_ID = "identityId";
    private static final String CLAIM_IDENTITY_TYPE = "identityType";
    private static final String CLAIM_ORG_ID = "orgId";

    private final AuthProperties properties;
    private final RefreshTokenStore refreshTokenStore;
    private final AccountRevocationStore accountRevocationStore;
    private final SecretKey signingKey;

    public TokenService(AuthProperties properties,
                        RefreshTokenStore refreshTokenStore,
                        AccountRevocationStore accountRevocationStore) {
        this.properties = properties;
        this.refreshTokenStore = refreshTokenStore;
        this.accountRevocationStore = accountRevocationStore;
        byte[] secret = properties.getJwtSecret().getBytes(StandardCharsets.UTF_8);
        if (secret.length < 32) {
            throw new IllegalStateException("xatodo.auth.jwt-secret 长度必须不少于 32 字节");
        }
        this.signingKey = Keys.hmacShaKeyFor(secret);
    }

    public String issueAccessToken(IdentityPrincipal principal) {
        Instant now = Instant.now();
        Instant expiresAt = now.plus(properties.getAccessTokenTtl());
        return Jwts.builder()
                .issuer(properties.getIssuer())
                .subject(String.valueOf(principal.accountId()))
                .claim(CLAIM_SCOPE, TokenScope.ACCESS.name())
                .claim(CLAIM_IDENTITY_ID, principal.identityId())
                .claim(CLAIM_IDENTITY_TYPE, principal.identityType())
                .claim(CLAIM_ORG_ID, principal.orgId())
                .issuedAt(Date.from(now))
                .expiration(Date.from(expiresAt))
                .signWith(signingKey)
                .compact();
    }

    /**
     * 解析访问令牌。非 ACCESS 作用域（注册令牌 / 选择身份令牌）一律视为无效。
     */
    public IdentityPrincipal parseAccessToken(String token) {
        Claims claims = parseClaims(token);
        if (!TokenScope.ACCESS.name().equals(claims.get(CLAIM_SCOPE, String.class))) {
            throw new JwtException("令牌作用域不允许访问业务接口");
        }
        Number orgId = claims.get(CLAIM_ORG_ID, Number.class);
        return new IdentityPrincipal(
                Long.valueOf(claims.getSubject()),
                claims.get(CLAIM_IDENTITY_ID, Number.class).longValue(),
                claims.get(CLAIM_IDENTITY_TYPE, String.class),
                orgId == null ? null : orgId.longValue());
    }

    public String issueScopedToken(Long accountId, TokenScope scope, Duration ttl) {
        Instant now = Instant.now();
        return Jwts.builder()
                .issuer(properties.getIssuer())
                .subject(String.valueOf(accountId))
                .claim(CLAIM_SCOPE, scope.name())
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(ttl)))
                .signWith(signingKey)
                .compact();
    }

    /**
     * 校验受限令牌并返回其所属账号；作用域不符时抛出 {@link ErrorCode#UNAUTHENTICATED}。
     */
    public Long parseScopedToken(String token, TokenScope expectedScope) {
        try {
            Claims claims = parseClaims(token);
            if (!expectedScope.name().equals(claims.get(CLAIM_SCOPE, String.class))) {
                throw BizException.of(ErrorCode.UNAUTHENTICATED);
            }
            return Long.valueOf(claims.getSubject());
        } catch (JwtException | IllegalArgumentException ex) {
            throw BizException.of(ErrorCode.UNAUTHENTICATED);
        }
    }

    public String issueRefreshToken(Long accountId, Long identityId, String deviceId) {
        String tokenId = UUID.randomUUID().toString().replace("-", "");
        RefreshTokenRecord record = new RefreshTokenRecord(
                tokenId, accountId, identityId, deviceId, Instant.now());
        refreshTokenStore.save(record, properties.getRefreshTokenTtl());
        refreshTokenStore.enforceDeviceLimit(identityId, properties.getMaxDevicesPerIdentity());
        return tokenId;
    }

    public RefreshTokenRecord requireRefreshToken(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            throw BizException.of(ErrorCode.REFRESH_TOKEN_INVALID);
        }
        return refreshTokenStore.find(refreshToken)
                .orElseThrow(() -> BizException.of(ErrorCode.REFRESH_TOKEN_INVALID));
    }

    public Optional<RefreshTokenRecord> findRefreshToken(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            return Optional.empty();
        }
        return refreshTokenStore.find(refreshToken);
    }

    /**
     * 轮换：登记「旧 → 新」关系后再作废旧令牌，使并发刷新在宽限期内可以拿回同一个新令牌。
     */
    public void linkRotation(String previousTokenId, String newTokenId) {
        refreshTokenStore.saveSuccessor(previousTokenId, newTokenId, properties.getRefreshRotationGrace());
        refreshTokenStore.delete(previousTokenId);
    }

    public Optional<String> findRotatedSuccessor(String previousTokenId) {
        return refreshTokenStore.findSuccessor(previousTokenId);
    }

    public void revokeAllForAccount(Long accountId) {
        refreshTokenStore.deleteAllForAccount(accountId);
    }

    /** 吊销某个身份的全部刷新令牌（解绑组织账号、身份被停用时用）。 */
    public void revokeAllForIdentity(Long identityId) {
        refreshTokenStore.deleteAllForIdentity(identityId);
    }

    /**
     * 让该账号**已经签发出去的**访问令牌立即失效（注销 / 封禁时调用）。
     *
     * <p>TTL 取访问令牌有效期：等这一批令牌自然过期后，这个标记就没有意义了，
     * 不需要额外的清理任务。
     */
    public void revokeAccountAccessTokens(Long accountId) {
        accountRevocationStore.revoke(accountId, Duration.ofSeconds(accessTokenTtlSeconds()));
    }

    /** 该账号是否已被作废（注销 / 封禁），鉴权过滤器每次解析访问令牌后都要问一次。 */
    public boolean isAccountRevoked(Long accountId) {
        return accountRevocationStore.isRevoked(accountId);
    }

    public List<RefreshTokenRecord> listSessionRecords(Long identityId) {
        return refreshTokenStore.listForIdentity(identityId);
    }

    /** 踢出指定设备；返回是否命中。 */
    public boolean revokeDevice(Long identityId, String deviceId) {
        Optional<RefreshTokenRecord> record = refreshTokenStore.findByDevice(identityId, deviceId);
        record.ifPresent(value -> refreshTokenStore.delete(value.tokenId()));
        return record.isPresent();
    }

    public void revokeRefreshToken(String refreshToken) {
        if (refreshToken != null && !refreshToken.isBlank()) {
            refreshTokenStore.delete(refreshToken);
        }
    }

    public long accessTokenTtlSeconds() {
        return properties.getAccessTokenTtl().toSeconds();
    }

    public AuthProperties properties() {
        return properties;
    }

    private Claims parseClaims(String token) {
        return Jwts.parser()
                .verifyWith(signingKey)
                .requireIssuer(properties.getIssuer())
                .build()
                .parseSignedClaims(token)
                .getPayload();
    }
}
