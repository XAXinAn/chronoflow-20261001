package com.xatodo.org.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.xatodo.common.persistence.JsonbStringTypeHandler;

/**
 * 导入的逐行结果。成功行记录新建成员 id，失败行记录原因，便于下载失败明细后修正重传。
 */
@TableName("import_row_result")
public class ImportRowResult {

    public static final String SUCCESS = "SUCCESS";
    public static final String FAILED = "FAILED";

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long batchId;

    private Integer rowNo;

    @TableField(typeHandler = JsonbStringTypeHandler.class)
    private String rawData;

    private String status;

    private String errorMessage;

    private Long createdMemberId;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getBatchId() {
        return batchId;
    }

    public void setBatchId(Long batchId) {
        this.batchId = batchId;
    }

    public Integer getRowNo() {
        return rowNo;
    }

    public void setRowNo(Integer rowNo) {
        this.rowNo = rowNo;
    }

    public String getRawData() {
        return rawData;
    }

    public void setRawData(String rawData) {
        this.rawData = rawData;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public String getErrorMessage() {
        return errorMessage;
    }

    public void setErrorMessage(String errorMessage) {
        this.errorMessage = errorMessage;
    }

    public Long getCreatedMemberId() {
        return createdMemberId;
    }

    public void setCreatedMemberId(Long createdMemberId) {
        this.createdMemberId = createdMemberId;
    }
}
