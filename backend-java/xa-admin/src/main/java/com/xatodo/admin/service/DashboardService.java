package com.xatodo.admin.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.admin.dto.AdminDtos.DashboardResponse;
import com.xatodo.auth.entity.Account;
import com.xatodo.auth.mapper.AccountMapper;
import com.xatodo.org.entity.EventDispatch;
import com.xatodo.org.entity.EventRecipient;
import com.xatodo.org.entity.OrgMember;
import com.xatodo.org.entity.Organization;
import com.xatodo.org.mapper.EventDispatchMapper;
import com.xatodo.org.mapper.EventRecipientMapper;
import com.xatodo.org.mapper.OrgMemberMapper;
import com.xatodo.org.mapper.OrganizationMapper;
import com.xatodo.personal.entity.Event;
import com.xatodo.personal.entity.Task;
import com.xatodo.personal.mapper.EventMapper;
import com.xatodo.personal.mapper.TaskMapper;
import org.springframework.stereotype.Service;

/**
 * 平台数据看板。首版为即席统计（count 查询）；数据量上来后应改为预聚合表。
 */
@Service
public class DashboardService {

    private final OrganizationMapper organizationMapper;
    private final AccountMapper accountMapper;
    private final OrgMemberMapper orgMemberMapper;
    private final EventMapper eventMapper;
    private final TaskMapper taskMapper;
    private final EventDispatchMapper eventDispatchMapper;
    private final EventRecipientMapper eventRecipientMapper;

    public DashboardService(OrganizationMapper organizationMapper,
                            AccountMapper accountMapper,
                            OrgMemberMapper orgMemberMapper,
                            EventMapper eventMapper,
                            TaskMapper taskMapper,
                            EventDispatchMapper eventDispatchMapper,
                            EventRecipientMapper eventRecipientMapper) {
        this.organizationMapper = organizationMapper;
        this.accountMapper = accountMapper;
        this.orgMemberMapper = orgMemberMapper;
        this.eventMapper = eventMapper;
        this.taskMapper = taskMapper;
        this.eventDispatchMapper = eventDispatchMapper;
        this.eventRecipientMapper = eventRecipientMapper;
    }

    public DashboardResponse stats() {
        long organizations = count(organizationMapper.selectCount(
                new LambdaQueryWrapper<Organization>().isNull(Organization::getDeletedAt)));
        long activeOrganizations = count(organizationMapper.selectCount(
                new LambdaQueryWrapper<Organization>()
                        .isNull(Organization::getDeletedAt)
                        .eq(Organization::getStatus, Organization.STATUS_ACTIVE)));
        long accounts = count(accountMapper.selectCount(null));
        long disabledAccounts = count(accountMapper.selectCount(
                new LambdaQueryWrapper<Account>().eq(Account::getStatus, "DISABLED")));
        long orgMembers = count(orgMemberMapper.selectCount(
                new LambdaQueryWrapper<OrgMember>().eq(OrgMember::getStatus, OrgMember.STATUS_ACTIVE)));
        long personalEvents = count(eventMapper.selectCount(
                new LambdaQueryWrapper<Event>()
                        .isNull(Event::getDeletedAt)
                        .eq(Event::getSourceType, Event.SOURCE_PERSONAL)));
        long tasks = count(taskMapper.selectCount(
                new LambdaQueryWrapper<Task>().isNull(Task::getDeletedAt)));
        long completedTasks = count(taskMapper.selectCount(
                new LambdaQueryWrapper<Task>()
                        .isNull(Task::getDeletedAt)
                        .eq(Task::getStatus, Task.STATUS_DONE)));
        long dispatches = count(eventDispatchMapper.selectCount(null));

        return new DashboardResponse(organizations, activeOrganizations, accounts, disabledAccounts,
                orgMembers, personalEvents, tasks, completedTasks, dispatches);
    }

    private long count(Long value) {
        return value == null ? 0L : value;
    }
}
