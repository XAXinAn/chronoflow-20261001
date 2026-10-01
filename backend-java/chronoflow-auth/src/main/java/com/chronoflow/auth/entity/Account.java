package com.chronoflow.auth.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.OffsetDateTime;

/**
 * 账号：以手机号为唯一登录凭证的「人」，见 spec §3.1。
 */
@TableName("account")
public class Account {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String phone;

    private OffsetDateTime phoneVerifiedAt;

    private String passwordHash;

    private String wechatUnionid;

    private String wechatOpenid;

    private String email;

    private OffsetDateTime emailVerifiedAt;

    // ---------------------------------------------------------------- 实名认证（V20）
    /** 真实姓名（认证通过后才有） */
    private String realName;
    /** 身份证号**密文**（AES-GCM，随机 IV）；明文只存在于请求体内，不落库、不落日志 */
    private String idCardCipher;
    /** 身份证号 HMAC 指纹：定长且确定性，用来做「同一实名信息只能绑一个账号」的唯一索引 */
    private String idCardFingerprint;
    private Boolean realNameVerified;
    private OffsetDateTime realNameVerifiedAt;

    private String status;

    private OffsetDateTime lastLoginAt;

    private OffsetDateTime createdAt;

    private OffsetDateTime updatedAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getPhone() {
        return phone;
    }

    public void setPhone(String phone) {
        this.phone = phone;
    }

    public OffsetDateTime getPhoneVerifiedAt() {
        return phoneVerifiedAt;
    }

    public void setPhoneVerifiedAt(OffsetDateTime phoneVerifiedAt) {
        this.phoneVerifiedAt = phoneVerifiedAt;
    }

    public String getPasswordHash() {
        return passwordHash;
    }

    public void setPasswordHash(String passwordHash) {
        this.passwordHash = passwordHash;
    }

    public String getWechatUnionid() {
        return wechatUnionid;
    }

    public void setWechatUnionid(String wechatUnionid) {
        this.wechatUnionid = wechatUnionid;
    }

    public String getWechatOpenid() {
        return wechatOpenid;
    }

    public void setWechatOpenid(String wechatOpenid) {
        this.wechatOpenid = wechatOpenid;
    }

    public String getEmail() {
        return email;
    }

    public void setEmail(String email) {
        this.email = email;
    }

    public OffsetDateTime getEmailVerifiedAt() {
        return emailVerifiedAt;
    }

    public void setEmailVerifiedAt(OffsetDateTime emailVerifiedAt) {
        this.emailVerifiedAt = emailVerifiedAt;
    }

    public String getRealName() {
        return realName;
    }

    public void setRealName(String realName) {
        this.realName = realName;
    }

    public String getIdCardCipher() {
        return idCardCipher;
    }

    public void setIdCardCipher(String idCardCipher) {
        this.idCardCipher = idCardCipher;
    }

    public String getIdCardFingerprint() {
        return idCardFingerprint;
    }

    public void setIdCardFingerprint(String idCardFingerprint) {
        this.idCardFingerprint = idCardFingerprint;
    }

    public Boolean getRealNameVerified() {
        return realNameVerified;
    }

    public void setRealNameVerified(Boolean realNameVerified) {
        this.realNameVerified = realNameVerified;
    }

    public OffsetDateTime getRealNameVerifiedAt() {
        return realNameVerifiedAt;
    }

    public void setRealNameVerifiedAt(OffsetDateTime realNameVerifiedAt) {
        this.realNameVerifiedAt = realNameVerifiedAt;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public OffsetDateTime getLastLoginAt() {
        return lastLoginAt;
    }

    public void setLastLoginAt(OffsetDateTime lastLoginAt) {
        this.lastLoginAt = lastLoginAt;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }

    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(OffsetDateTime updatedAt) {
        this.updatedAt = updatedAt;
    }
}
