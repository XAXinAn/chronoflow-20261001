package com.chronoflow.personal.dto;

/**
 * 检索命中的组织日程（spec §4.1.7）。
 *
 * <p>只取「定位这条结果」需要的字段：日程本体用来做时间与重复展开，身份/组织用来跳转。
 * 用普通类而不是 record：MyBatis 需要无参构造 + setter 来做列名映射。
 */
public class OrgEventHit {

    private Long eventId;
    private Long identityId;
    private Long orgId;
    private String orgName;

    public Long getEventId() {
        return eventId;
    }

    public void setEventId(Long eventId) {
        this.eventId = eventId;
    }

    public Long getIdentityId() {
        return identityId;
    }

    public void setIdentityId(Long identityId) {
        this.identityId = identityId;
    }

    public Long getOrgId() {
        return orgId;
    }

    public void setOrgId(Long orgId) {
        this.orgId = orgId;
    }

    public String getOrgName() {
        return orgName;
    }

    public void setOrgName(String orgName) {
        this.orgName = orgName;
    }
}
