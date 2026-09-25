package com.xatodo.org.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.org.config.AsyncConfig;
import com.xatodo.org.dto.OrgDtos.DepartmentCreateRequest;
import com.xatodo.org.dto.OrgDtos.ImportRow;
import com.xatodo.org.entity.Department;
import com.xatodo.org.entity.ImportBatch;
import com.xatodo.org.entity.ImportRowResult;
import com.xatodo.org.entity.OrgMember;
import com.xatodo.org.mapper.DepartmentMapper;
import com.xatodo.org.mapper.ImportBatchMapper;
import com.xatodo.org.mapper.ImportRowResultMapper;
import com.xatodo.org.mapper.OrgMemberMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 批量导入的异步执行器。
 *
 * <p>本类**不能**加事务注解：逐行创建成员走 {@code OrgMemberService#createMemberInternal} 的独立事务，
 * 某一行失败只回滚该行，不会污染整批（PostgreSQL 中事务一旦出错即进入 aborted 状态，无法继续）。
 */
@Component
public class MemberImportProcessor {

    private static final Logger log = LoggerFactory.getLogger(MemberImportProcessor.class);
    private static final Pattern PHONE = Pattern.compile("^1[3-9]\\d{9}$");
    private static final Set<String> ROLES = Set.of("OWNER", "ADMIN", "MEMBER");

    private final OrgMemberMapper orgMemberMapper;
    private final DepartmentMapper departmentMapper;
    private final ImportBatchMapper importBatchMapper;
    private final ImportRowResultMapper importRowResultMapper;
    private final OrgMemberService orgMemberService;
    private final DepartmentService departmentService;
    private final OrgPermissionService permission;
    private final ObjectMapper objectMapper;

    public MemberImportProcessor(OrgMemberMapper orgMemberMapper,
                                 DepartmentMapper departmentMapper,
                                 ImportBatchMapper importBatchMapper,
                                 ImportRowResultMapper importRowResultMapper,
                                 OrgMemberService orgMemberService,
                                 DepartmentService departmentService,
                                 OrgPermissionService permission,
                                 ObjectMapper objectMapper) {
        this.orgMemberMapper = orgMemberMapper;
        this.departmentMapper = departmentMapper;
        this.importBatchMapper = importBatchMapper;
        this.importRowResultMapper = importRowResultMapper;
        this.orgMemberService = orgMemberService;
        this.departmentService = departmentService;
        this.permission = permission;
        this.objectMapper = objectMapper;
    }

    @Async(AsyncConfig.IMPORT_EXECUTOR)
    public void process(Long batchId, Long actorMemberId, List<ImportRow> rows, boolean autoCreateDepartment) {
        ImportBatch batch = importBatchMapper.selectById(batchId);
        OrgMember actor = orgMemberMapper.selectById(actorMemberId);
        if (batch == null || actor == null) {
            log.warn("导入批次或发起人不存在，跳过。batchId={}, actorMemberId={}", batchId, actorMemberId);
            return;
        }

        // 自动建部门会创建组织级结构，仅组织管理员可用
        if (autoCreateDepartment && !permission.isOrgAdmin(actor)) {
            finish(batch, 0, rows.size(), ImportBatch.FAILED);
            return;
        }

        Set<Long> manageable = permission.manageableDepartmentIds(actor);
        int success = 0;
        int failed = 0;

        for (ImportRow row : rows) {
            try {
                validate(row);
                ResolvedDepartment resolved = resolveDepartment(actor, row.departmentPath(), autoCreateDepartment);
                if (resolved.created()) {
                    // 自动创建了新部门，可管理部门集合已发生变化，必须重算后再校验
                    manageable = permission.manageableDepartmentIds(actor);
                }
                if (!manageable.contains(resolved.department().getId())) {
                    throw BizException.of(ErrorCode.FORBIDDEN, "无权向该部门导入成员");
                }
                String role = StringUtils.hasText(row.role())
                        ? row.role().trim().toUpperCase(Locale.ROOT)
                        : OrgMember.ROLE_MEMBER;
                if (!ROLES.contains(role)) {
                    throw BizException.of(ErrorCode.PARAM_INVALID, "角色取值非法: " + row.role());
                }
                if (!OrgMember.ROLE_MEMBER.equals(role)) {
                    permission.requireOrgAdmin(actor);
                }

                OrgMember created = orgMemberService.createMemberInternal(
                        actor.getOrgId(), resolved.department().getId(), row.phone(), row.realName(),
                        row.memberNo(), row.email(), null, role);
                record(batchId, row, ImportRowResult.SUCCESS, null, created.getId());
                success++;
            } catch (Exception ex) {
                record(batchId, row, ImportRowResult.FAILED, friendlyMessage(ex), null);
                failed++;
            }
            if ((success + failed) % 50 == 0) {
                updateProgress(batch, success, failed);
            }
        }

        finish(batch, success, failed,
                failed == 0 ? ImportBatch.SUCCESS
                        : (success == 0 ? ImportBatch.FAILED : ImportBatch.PARTIAL_FAILED));
    }

    private void validate(ImportRow row) {
        if (!StringUtils.hasText(row.realName())) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "姓名不能为空");
        }
        if (!StringUtils.hasText(row.phone())) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "手机号不能为空");
        }
        if (!PHONE.matcher(row.phone()).matches()) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "手机号格式不正确: " + row.phone());
        }
        if (!StringUtils.hasText(row.departmentPath())) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "部门路径不能为空");
        }
    }

    /**
     * 按「技术中心/后端组」逐级查找部门；允许自动创建时逐级补建。
     */
    private ResolvedDepartment resolveDepartment(OrgMember actor, String path, boolean autoCreate) {
        Department current = null;
        boolean created = false;
        for (String raw : path.split("/")) {
            String name = raw.trim();
            if (name.isEmpty()) {
                continue;
            }
            Department found = findChild(actor.getOrgId(), current == null ? null : current.getId(), name);
            if (found == null) {
                if (!autoCreate) {
                    throw BizException.of(ErrorCode.PARAM_INVALID, "部门路径不存在: " + path);
                }
                found = departmentService.create(actor,
                        new DepartmentCreateRequest(current == null ? null : current.getId(), name, 0));
                created = true;
            }
            current = found;
        }
        if (current == null) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "部门路径不能为空");
        }
        return new ResolvedDepartment(current, created);
    }

    private record ResolvedDepartment(Department department, boolean created) {
    }

    private Department findChild(Long orgId, Long parentId, String name) {
        LambdaQueryWrapper<Department> query = new LambdaQueryWrapper<Department>()
                .eq(Department::getOrgId, orgId)
                .eq(Department::getName, name)
                .eq(Department::getStatus, Department.STATUS_ACTIVE);
        if (parentId == null) {
            query.isNull(Department::getParentId);
        } else {
            query.eq(Department::getParentId, parentId);
        }
        return departmentMapper.selectOne(query.last("LIMIT 1"));
    }

    private void record(Long batchId, ImportRow row, String status, String error, Long memberId) {
        ImportRowResult result = new ImportRowResult();
        result.setBatchId(batchId);
        result.setRowNo(row.rowNo());
        result.setRawData(toJson(row));
        result.setStatus(status);
        result.setErrorMessage(error);
        result.setCreatedMemberId(memberId);
        importRowResultMapper.insert(result);
    }

    private String toJson(ImportRow row) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("realName", row.realName());
        map.put("phone", row.phone());
        map.put("email", row.email());
        map.put("memberNo", row.memberNo());
        map.put("departmentPath", row.departmentPath());
        map.put("role", row.role());
        try {
            return objectMapper.writeValueAsString(map);
        } catch (Exception ex) {
            return "{}";
        }
    }

    private String friendlyMessage(Exception ex) {
        if (ex instanceof BizException biz) {
            return biz.getMessage();
        }
        if (ex instanceof DataAccessException) {
            return "数据冲突：该手机号或工号可能已存在";
        }
        return ex.getMessage() == null ? "导入失败" : ex.getMessage();
    }

    private void updateProgress(ImportBatch batch, int success, int failed) {
        batch.setSuccessCount(success);
        batch.setFailCount(failed);
        importBatchMapper.updateById(batch);
    }

    private void finish(ImportBatch batch, int success, int failed, String status) {
        batch.setSuccessCount(success);
        batch.setFailCount(failed);
        batch.setStatus(status);
        batch.setFinishedAt(OffsetDateTime.now(ZoneOffset.UTC));
        importBatchMapper.updateById(batch);
    }
}
