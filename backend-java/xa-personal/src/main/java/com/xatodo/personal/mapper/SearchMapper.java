package com.xatodo.personal.mapper;

import com.xatodo.personal.entity.Event;
import com.xatodo.personal.entity.Task;
import com.xatodo.personal.dto.OrgEventHit;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;

/**
 * 关键字检索（spec §4.1.7 / §6.2 GET /search）。
 *
 * <p>单独一个 mapper 而不是塞进 EventMapper / TaskMapper：这两条 SQL 的用途是「跨模型的统一检索」，
 * 与各自的 CRUD 关注点不同；放在一起会让两个 mapper 都得跟着检索语义变。
 */
@Mapper
public interface SearchMapper {

    /**
     * 当前身份个人日历下的日程。
     *
     * <p>`ESCAPE '\'` 是必须的：用户输入的关键字里出现 `%` 或 `_` 时，
     * 不转义就会变成通配符——搜「50%」会命中所有日程，这是典型的静默错行为。
     */
    @Select("""
            SELECT e.*
            FROM event e
            JOIN calendar c ON c.id = e.calendar_id
            WHERE c.owner_identity_id = #{identityId}
              AND e.deleted_at IS NULL
              AND e.status <> 'CANCELLED'
              AND (e.title ILIKE #{pattern} ESCAPE '\\'
                   OR e.description ILIKE #{pattern} ESCAPE '\\'
                   OR e.location_name ILIKE #{pattern} ESCAPE '\\')
            ORDER BY e.start_at DESC
            LIMIT #{limit}
            """)
    List<Event> searchEvents(@Param("identityId") Long identityId,
                             @Param("pattern") String pattern,
                             @Param("limit") int limit);

    /** 当前身份自己的待办。已完成/已取消的也返回：用户经常要回头找「上个月做掉的那件事」。 */
    @Select("""
            SELECT t.*
            FROM task t
            WHERE t.owner_identity_id = #{identityId}
              AND t.deleted_at IS NULL
              AND (t.title ILIKE #{pattern} ESCAPE '\\'
                   OR t.description ILIKE #{pattern} ESCAPE '\\')
            ORDER BY t.due_at DESC NULLS LAST
            LIMIT #{limit}
            """)
    List<Task> searchTasks(@Param("identityId") Long identityId,
                           @Param("pattern") String pattern,
                           @Param("limit") int limit);

    /**
     * 我绑定过的**所有组织**下发给我的组织日程（spec §4.1.7）。
     *
     * <p>三条过滤都不能少：
     * <ul>
     *   <li>`i.account_id` + `i.status='ACTIVE'`：只搜当前账号当前有效的组织身份；</li>
     *   <li>`m.status='ACTIVE'`：已离职/停用的成员不再看到组织日程；</li>
     *   <li>`d.status='ACTIVE'`：**撤回过的下发不出现**，否则用户会搜到一个点开就没了的活动。</li>
     * </ul>
     */
    @Select("""
            SELECT DISTINCT e.id AS event_id, i.id AS identity_id, o.id AS org_id, o.name AS org_name
            FROM event_recipient r
            JOIN org_member m ON m.id = r.org_member_id
            JOIN identity i ON i.id = m.identity_id
            JOIN event_dispatch d ON d.id = r.dispatch_id
            JOIN event e ON e.id = r.event_id
            JOIN organization o ON o.id = i.org_id
            WHERE i.account_id = #{accountId}
              AND i.identity_type = 'ORG_MEMBER'
              AND i.status = 'ACTIVE'
              AND m.status = 'ACTIVE'
              AND d.status = 'ACTIVE'
              AND e.deleted_at IS NULL
              AND e.status <> 'CANCELLED'
              AND o.deleted_at IS NULL
              AND (e.title ILIKE #{pattern} ESCAPE '\\'
                   OR e.description ILIKE #{pattern} ESCAPE '\\'
                   OR e.location_name ILIKE #{pattern} ESCAPE '\\')
            ORDER BY e.id DESC
            LIMIT #{limit}
            """)
    List<OrgEventHit> searchOrgEvents(@Param("accountId") Long accountId,
                                      @Param("pattern") String pattern,
                                      @Param("limit") int limit);
}
