package com.chronoflow.auth.service;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.chronoflow.auth.dto.AccountSecurityDtos.AccountSecurityView;
import com.chronoflow.auth.entity.Account;
import com.chronoflow.auth.mapper.AccountMapper;
import com.chronoflow.common.api.ErrorCode;
import com.chronoflow.common.exception.BizException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;

/**
 * 「账号与安全」的读写（spec §6.2）：邮箱绑定与实名结果的落库。
 *
 * <p>两者都挂在 **account** 上（不是 identity）：邮箱与实名是「人」的属性，
 * 切到组织身份也一样，见 V2 里 email 放 account 的判断与 V20 的注释。
 */
@Service
public class AccountSecurityService {

    private final AccountMapper accountMapper;

    public AccountSecurityService(AccountMapper accountMapper) {
        this.accountMapper = accountMapper;
    }

    public AccountSecurityView view(Long accountId) {
        Account account = requireAccount(accountId);
        return new AccountSecurityView(
                account.getEmail(),
                account.getEmailVerifiedAt() != null,
                Boolean.TRUE.equals(account.getRealNameVerified()),
                account.getRealName());
    }

    /**
     * 绑定 / 改绑邮箱。验证码已在校验通过时被消费（见 {@code EmailCodeService.verify}）。
     *
     * <p>邮箱在库里唯一：被别人占了就如实拒绝，不覆盖别人。
     */
    @Transactional
    public AccountSecurityView bindEmail(Long accountId, String email) {
        String normalized = email.trim().toLowerCase();
        Long taken = accountMapper.selectCount(new QueryWrapper<Account>()
                .eq("email", normalized)
                .ne("id", accountId));
        if (taken != null && taken > 0) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "该邮箱已被其他账号绑定");
        }
        Account update = new Account();
        update.setId(accountId);
        update.setEmail(normalized);
        update.setEmailVerifiedAt(OffsetDateTime.now());
        accountMapper.updateById(update);
        return view(accountId);
    }

    /**
     * 实名认证通过后落库。
     *
     * <p>同一份实名信息只能绑一个账号：靠 `id_card_fingerprint` 的唯一索引兜底
     * （并发下也不会出现两份），撞了就翻译成一句人话。
     */
    @Transactional
    public void saveVerifiedRealName(Long accountId, String realName, String idCardCipher, String fingerprint) {
        Long taken = accountMapper.selectCount(new QueryWrapper<Account>()
                .eq("id_card_fingerprint", fingerprint)
                .ne("id", accountId));
        if (taken != null && taken > 0) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "该实名信息已被其他账号绑定");
        }
        Account update = new Account();
        update.setId(accountId);
        update.setRealName(realName);
        update.setIdCardCipher(idCardCipher);
        update.setIdCardFingerprint(fingerprint);
        update.setRealNameVerified(true);
        update.setRealNameVerifiedAt(OffsetDateTime.now());
        accountMapper.updateById(update);
    }

    private Account requireAccount(Long accountId) {
        Account account = accountMapper.selectById(accountId);
        if (account == null) {
            throw BizException.of(ErrorCode.IDENTITY_UNAVAILABLE, "账号不存在");
        }
        return account;
    }
}
