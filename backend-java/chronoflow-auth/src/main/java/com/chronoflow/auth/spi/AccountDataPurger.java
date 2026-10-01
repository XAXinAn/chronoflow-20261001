package com.chronoflow.auth.spi;

/**
 * 账号注销时清理「不属于 chronoflow-auth 的那些数据」的出口。
 *
 * <p>注销要同时做四件事：吊销令牌、停用身份、匿名化账号、**清掉个人数据并解绑组织账号**。
 * 前两件事的数据（{@code account} / {@code identity}）就在 chronoflow-auth，后两件事分散在
 * chronoflow-personal（日历 / 日程 / 待办 / 提醒）与 chronoflow-org（组织成员关系）。
 *
 * <p>让 chronoflow-auth 反向依赖那两个模块会把模块图打成环，因此这里只声明接口，
 * 由组合根 {@code chronoflow-bootstrap} 提供实现——与 {@code OrgAuditSink} 是同一套做法。
 *
 * <p>用 {@code ObjectProvider} 注入：没有实现时（例如只加载 chronoflow-auth 的切片测试）
 * 注销仍然完成「账号侧」的部分，不会因为缺一个可选实现就整个失败。
 */
public interface AccountDataPurger {

    /**
     * 删除该账号下的个人数据，并解除它与全部组织账号的绑定。
     *
     * <p>实现方**不得**删除 {@code account} / {@code identity} 行：那是 chronoflow-auth 的职责，
     * 而且组织日程的历史记录仍然通过 {@code event.creator_identity_id} 引用身份行。
     */
    void purge(Long accountId);
}
