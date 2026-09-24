package com.xatodo.auth.service;

import com.xatodo.auth.config.AuthProperties;
import com.xatodo.auth.security.IdentityPrincipal;
import com.xatodo.auth.security.TokenScope;
import com.xatodo.auth.store.RefreshTokenRecord;
import com.xatodo.auth.store.RefreshTokenStore;
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
    private final SecretKey signingKey;

    public TokenService(AuthProperties properties, RefreshTokenStore refreshTokenStore) {
        this.properties = properties;
        this.refreshTokenStore = refreshTokenStore;
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
