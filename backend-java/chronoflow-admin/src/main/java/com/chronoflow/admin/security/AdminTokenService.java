package com.chronoflow.admin.security;

import com.chronoflow.admin.entity.AdminUser;
import com.chronoflow.auth.config.AuthProperties;
import com.chronoflow.auth.security.TokenScope;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;

/**
 * 后台管理员令牌。复用与 C 端相同的签名密钥，但作用域为 {@link TokenScope#ADMIN}，
 * 因此管理员令牌无法访问 C 端业务接口，反之亦然。
 */
@Service
public class AdminTokenService {

    private static final String CLAIM_SCOPE = "scope";
    private static final String CLAIM_ADMIN_ROLE = "adminRole";
    private static final String CLAIM_ORG_ID = "orgId";

    private final AuthProperties properties;
    private final SecretKey signingKey;

    public AdminTokenService(AuthProperties properties) {
        this.properties = properties;
        this.signingKey = Keys.hmacShaKeyFor(properties.getJwtSecret().getBytes(StandardCharsets.UTF_8));
    }

    public String issue(AdminUser admin) {
        Instant now = Instant.now();
        return Jwts.builder()
                .issuer(properties.getIssuer())
                .subject(String.valueOf(admin.getId()))
                .claim(CLAIM_SCOPE, TokenScope.ADMIN.name())
                .claim("username", admin.getUsername())
                .claim(CLAIM_ADMIN_ROLE, admin.getRole())
                .claim(CLAIM_ORG_ID, admin.getOrgId())
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(properties.getAccessTokenTtl())))
                .signWith(signingKey)
                .compact();
    }

    public AdminPrincipal parse(String token) {
        try {
            Claims claims = Jwts.parser()
                    .verifyWith(signingKey)
                    .requireIssuer(properties.getIssuer())
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();
            if (!TokenScope.ADMIN.name().equals(claims.get(CLAIM_SCOPE, String.class))) {
                throw BizException.of(ErrorCode.UNAUTHENTICATED, "令牌作用域不允许访问后台接口");
            }
            Number orgId = claims.get(CLAIM_ORG_ID, Number.class);
            return new AdminPrincipal(
                    Long.valueOf(claims.getSubject()),
                    claims.get("username", String.class),
                    claims.get(CLAIM_ADMIN_ROLE, String.class),
                    orgId == null ? null : orgId.longValue());
        } catch (JwtException | IllegalArgumentException ex) {
            throw BizException.of(ErrorCode.UNAUTHENTICATED);
        }
    }

    public long ttlSeconds() {
        return properties.getAccessTokenTtl().toSeconds();
    }
}
