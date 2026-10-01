package com.chronoflow.bootstrap.compliance;

import com.chronoflow.auth.spi.AccountDataPurger;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 注销账号时清理个人数据、解除组织绑定（{@link AccountDataPurger} 的实现）。
 *
 * <p>放在 chronoflow-bootstrap（组合根）而不是某个业务模块：要清的数据横跨 chronoflow-personal（日历 / 日程 /
 * 待办 / 提醒）与 chronoflow-org（组织成员关系），让 chronoflow-auth 直接依赖它们会把模块图打成环。
 *
 * <p>用 SQL 而不是各模块的 Service：注销是**一次性的数据处置**，不是业务操作，
 * 走 Service 反而会被各模块的业务规则（比如「组织日程只有发起人能删」）挡住——
 * 那些规则保护的是用户操作，不该保护「账号已经注销」这件事。
 *
 * <p>注意这里**不动** {@code event} 里属于组织的日程：那是组织的资产，
 * 发起人注销不应该让同事的日历空掉。同理只置空 {@code org_member.identity_id}，
 * 组织侧的成员记录保留，可以被重新认领。
 */
@Component
public class JdbcAccountDataPurger implements AccountDataPurger {

    /** 本账号的全部个人日历。 */
    private static final String PERSONAL_CALENDARS = """
            (SELECT id FROM calendar
              WHERE calendar_type = 'PERSONAL'
                AND owner_identity_id IN (SELECT id FROM identity WHERE account_id = ?))
            """;

    private final JdbcTemplate jdbcTemplate;

    public JdbcAccountDataPurger(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Override
    public void purge(Long accountId) {
        // 1) 解除组织绑定：组织侧成员记录保留（spec §3.2 的解绑语义），可被原学号/工号重新认领
        jdbcTemplate.update("""
                UPDATE org_member SET identity_id = NULL, updated_at = now()
                 WHERE identity_id IN (SELECT id FROM identity WHERE account_id = ?)
                """, accountId);

        // 2) 提醒：自己设置的提醒全部删掉（target_type 是多态引用，没有外键兜底，只能显式删）
        jdbcTemplate.update(
                "DELETE FROM reminder WHERE identity_id IN (SELECT id FROM identity WHERE account_id = ?)",
                accountId);

        // 3) 别人的待办里如果关联了本账号的个人日程，先断开关联再删日程——
        //    待办是对方的数据，不能因为日程没了就跟着消失（spec §4.1.6）
        jdbcTemplate.update("""
                UPDATE task SET event_id = NULL, updated_at = now()
                 WHERE event_id IN (SELECT id FROM event WHERE calendar_id IN """ + PERSONAL_CALENDARS + ")",
                accountId);

        // 4) 个人日程（event_exception 由 ON DELETE CASCADE 带走）
        jdbcTemplate.update(
                "DELETE FROM event WHERE calendar_id IN " + PERSONAL_CALENDARS, accountId);

        // 5) 待办：先断父子关系，再整批删除（task.parent_task_id 是自引用外键）
        jdbcTemplate.update("""
                UPDATE task SET parent_task_id = NULL, updated_at = now()
                 WHERE owner_identity_id IN (SELECT id FROM identity WHERE account_id = ?)
                """, accountId);
        jdbcTemplate.update(
                "DELETE FROM task WHERE owner_identity_id IN (SELECT id FROM identity WHERE account_id = ?)",
                accountId);

        // 6) 个人日历本身
        jdbcTemplate.update("DELETE FROM calendar WHERE calendar_type = 'PERSONAL'"
                + " AND owner_identity_id IN (SELECT id FROM identity WHERE account_id = ?)", accountId);

        // 7) 意见反馈：含正文与图片，属于该账号的个人信息，一并删除
        jdbcTemplate.update("DELETE FROM feedback WHERE account_id = ?", accountId);

        // 8) 登录日志刻意**不删**：按《网络安全法》第二十一条要留存不少于 6 个月，
        //    而账号行已经在 AccountService 里匿名化，日志里也不含手机号。
        //    这条注释是给下一个 agent 的：别把「没删 login_log」当成漏掉。
    }
}
