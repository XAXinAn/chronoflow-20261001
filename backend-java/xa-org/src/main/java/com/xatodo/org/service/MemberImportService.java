package com.xatodo.org.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xatodo.common.api.ErrorCode;
import com.xatodo.common.exception.BizException;
import com.xatodo.org.config.AsyncConfig;
import com.xatodo.org.dto.OrgDtos.ImportBatchResponse;
import com.xatodo.org.dto.OrgDtos.ImportRow;
import com.xatodo.org.dto.OrgDtos.ImportRowResponse;
import com.xatodo.org.entity.ImportBatch;
import com.xatodo.org.entity.ImportRowResult;
import com.xatodo.org.entity.OrgMember;
import com.xatodo.org.mapper.ImportBatchMapper;
import com.xatodo.org.mapper.ImportRowResultMapper;
import org.apache.commons.csv.CSVFormat;
import org.apache.commons.csv.CSVParser;
import org.apache.commons.csv.CSVRecord;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 成员批量导入（spec §4.3）。
 *
 * <p>模板列：姓名、手机号、邮箱（选填）、工号（选填）、部门路径（如「技术中心/后端组」）、角色（选填）。
 * 成功行照常入库，失败行逐行记录原因；单次上限 5000 行，异步执行。
 */
@Service
public class MemberImportService {

    public static final int MAX_ROWS = 5000;
    private static final String[] HEADERS = {"姓名", "手机号", "邮箱", "工号", "部门路径", "角色"};

    private final ImportBatchMapper importBatchMapper;
    private final ImportRowResultMapper importRowResultMapper;
    private final MemberImportProcessor processor;

    public MemberImportService(ImportBatchMapper importBatchMapper,
                               ImportRowResultMapper importRowResultMapper,
                               MemberImportProcessor processor) {
        this.importBatchMapper = importBatchMapper;
        this.importRowResultMapper = importRowResultMapper;
        this.processor = processor;
    }

    /**
     * 解析并登记批次，随后交由异步处理器逐行入库。接口立即返回 batchId 供查询进度。
     */
    @Transactional
    public ImportBatch startImport(OrgMember actor, String fileName, byte[] content, boolean autoCreateDepartment) {
        List<ImportRow> rows = parse(content, fileName);
        if (rows.isEmpty()) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "文件中没有可导入的数据行");
        }
        if (rows.size() > MAX_ROWS) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "单次导入最多 " + MAX_ROWS + " 行，当前 " + rows.size() + " 行");
        }

        ImportBatch batch = new ImportBatch();
        batch.setOrgId(actor.getOrgId());
        batch.setFileName(fileName);
        // 原始文件暂不落对象存储，仅保留引用占位（spec §9 的 MinIO 接入待补）
        batch.setFileUrl("pending-storage://" + System.currentTimeMillis() + "/" + fileName);
        batch.setTotalCount(rows.size());
        batch.setSuccessCount(0);
        batch.setFailCount(0);
        batch.setStatus(ImportBatch.PROCESSING);
        batch.setCreatedByMemberId(actor.getId());
        importBatchMapper.insert(batch);

        processor.process(batch.getId(), actor.getId(), rows, autoCreateDepartment);
        return batch;
    }

    public List<ImportBatch> listBatches(OrgMember actor) {
        return importBatchMapper.selectList(new LambdaQueryWrapper<ImportBatch>()
                .eq(ImportBatch::getOrgId, actor.getOrgId())
                .orderByDesc(ImportBatch::getId));
    }

    public ImportBatchResponse detail(OrgMember actor, Long batchId) {
        ImportBatch batch = requireBatch(actor, batchId);
        List<ImportRowResponse> rows = importRowResultMapper.selectList(
                        new LambdaQueryWrapper<ImportRowResult>()
                                .eq(ImportRowResult::getBatchId, batchId)
                                .orderByAsc(ImportRowResult::getRowNo))
                .stream()
                .map(row -> new ImportRowResponse(row.getRowNo(), row.getStatus(),
                        row.getErrorMessage(), row.getCreatedMemberId(), row.getRawData()))
                .toList();
        return new ImportBatchResponse(batch.getId(), batch.getFileName(), batch.getStatus(),
                batch.getTotalCount(), batch.getSuccessCount(), batch.getFailCount(),
                batch.getCreatedAt(), batch.getFinishedAt(), rows);
    }

    /**
     * 失败明细导出为 CSV，便于修正后重传。
     */
    public String failureCsv(OrgMember actor, Long batchId) {
        requireBatch(actor, batchId);
        List<ImportRowResult> failures = importRowResultMapper.selectList(
                new LambdaQueryWrapper<ImportRowResult>()
                        .eq(ImportRowResult::getBatchId, batchId)
                        .eq(ImportRowResult::getStatus, ImportRowResult.FAILED)
                        .orderByAsc(ImportRowResult::getRowNo));

        StringBuilder csv = new StringBuilder();
        csv.append(String.join(",", List.of("行号", "原始数据", "失败原因"))).append('\n');
        for (ImportRowResult failure : failures) {
            csv.append(failure.getRowNo()).append(',')
                    .append(escapeCsv(failure.getRawData())).append(',')
                    .append(escapeCsv(failure.getErrorMessage())).append('\n');
        }
        return csv.toString();
    }

    /**
     * 生成 .xlsx 导入模板（表头 + 一行示例）。
     */
    public byte[] template() {
        try (Workbook workbook = new XSSFWorkbook();
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Sheet sheet = workbook.createSheet("成员导入");
            Row header = sheet.createRow(0);
            for (int i = 0; i < HEADERS.length; i++) {
                header.createCell(i).setCellValue(HEADERS[i]);
                sheet.setColumnWidth(i, 18 * 256);
            }
            Row example = sheet.createRow(1);
            String[] sample = {"张三", "13800000000", "zhangsan@example.com", "E1001", "技术中心/后端组", "MEMBER"};
            for (int i = 0; i < sample.length; i++) {
                example.createCell(i).setCellValue(sample[i]);
            }
            workbook.write(out);
            return out.toByteArray();
        } catch (IOException ex) {
            throw new IllegalStateException("生成导入模板失败", ex);
        }
    }

    public ImportBatch requireBatch(OrgMember actor, Long batchId) {
        ImportBatch batch = importBatchMapper.selectById(batchId);
        if (batch == null || !actor.getOrgId().equals(batch.getOrgId())) {
            throw BizException.of(ErrorCode.FORBIDDEN, "导入批次不存在或不属于当前组织");
        }
        return batch;
    }

    // ------------------------------------------------------------- 文件解析

    public List<ImportRow> parse(byte[] content, String fileName) {
        if (content == null || content.length == 0) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "上传文件为空");
        }
        String lower = fileName == null ? "" : fileName.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".csv")) {
            return parseCsv(content);
        }
        if (lower.endsWith(".xlsx")) {
            return parseXlsx(content);
        }
        throw BizException.of(ErrorCode.PARAM_INVALID, "仅支持 .xlsx 或 .csv 文件");
    }

    private List<ImportRow> parseCsv(byte[] content) {
        List<ImportRow> rows = new ArrayList<>();
        byte[] normalized = stripBom(content);
        try (Reader reader = new InputStreamReader(new ByteArrayInputStream(normalized), StandardCharsets.UTF_8);
             CSVParser parser = CSVParser.parse(reader, CSVFormat.DEFAULT.builder()
                     .setTrim(true)
                     .setIgnoreEmptyLines(true)
                     .get())) {
            int index = 0;
            for (CSVRecord record : parser) {
                index++;
                if (index == 1) {
                    continue;   // 表头
                }
                rows.add(new ImportRow(index,
                        value(record, 0), value(record, 1), value(record, 2),
                        value(record, 3), value(record, 4), value(record, 5)));
            }
        } catch (IOException ex) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "CSV 解析失败: " + ex.getMessage());
        }
        return rows;
    }

    private List<ImportRow> parseXlsx(byte[] content) {
        List<ImportRow> rows = new ArrayList<>();
        try (Workbook workbook = new XSSFWorkbook(new ByteArrayInputStream(content))) {
            Sheet sheet = workbook.getSheetAt(0);
            if (sheet == null) {
                return rows;
            }
            DataFormatter formatter = new DataFormatter();
            for (int index = 1; index <= sheet.getLastRowNum(); index++) {
                Row row = sheet.getRow(index);
                if (row == null || isBlankRow(row, formatter)) {
                    continue;
                }
                rows.add(new ImportRow(index + 1,
                        cellText(row.getCell(0), formatter), cellText(row.getCell(1), formatter),
                        cellText(row.getCell(2), formatter), cellText(row.getCell(3), formatter),
                        cellText(row.getCell(4), formatter), cellText(row.getCell(5), formatter)));
            }
        } catch (IOException ex) {
            throw BizException.of(ErrorCode.PARAM_INVALID, "Excel 解析失败: " + ex.getMessage());
        }
        return rows;
    }

    private boolean isBlankRow(Row row, DataFormatter formatter) {
        for (int i = 0; i < HEADERS.length; i++) {
            if (StringUtils.hasText(cellText(row.getCell(i), formatter))) {
                return false;
            }
        }
        return true;
    }

    /**
     * 手机号常被 Excel 当作数字存储，直接取值会得到科学计数法，因此需要按整数还原。
     */
    private String cellText(Cell cell, DataFormatter formatter) {
        if (cell == null) {
            return null;
        }
        if (cell.getCellType() == CellType.NUMERIC) {
            double value = cell.getNumericCellValue();
            if (value == Math.floor(value) && !Double.isInfinite(value)) {
                return BigDecimal.valueOf((long) value).toPlainString();
            }
        }
        String text = formatter.formatCellValue(cell);
        return StringUtils.hasText(text) ? text.trim() : null;
    }

    private String value(CSVRecord record, int index) {
        if (record.size() <= index) {
            return null;
        }
        String text = record.get(index);
        return StringUtils.hasText(text) ? text.trim() : null;
    }

    private byte[] stripBom(byte[] content) {
        if (content.length >= 3
                && (content[0] & 0xFF) == 0xEF
                && (content[1] & 0xFF) == 0xBB
                && (content[2] & 0xFF) == 0xBF) {
            byte[] stripped = new byte[content.length - 3];
            System.arraycopy(content, 3, stripped, 0, stripped.length);
            return stripped;
        }
        return content;
    }

    private String escapeCsv(String value) {
        if (value == null) {
            return "";
        }
        return "\"" + value.replace("\"", "\"\"") + "\"";
    }
}
