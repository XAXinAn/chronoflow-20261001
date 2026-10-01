import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { App as AntdApp, Alert, Button, Form, Input, Space, Table, Typography } from 'antd';
import { useState } from 'react';

import { api } from '../api';
import type { AuditLog } from '../api/types';
import { useLoad } from '../hooks/useLoad';

export function AuditLogsPage() {
  const { message } = AntdApp.useApp();
  const [query, setQuery] = useState<{ action?: string; actorName?: string; limit?: number }>({ limit: 100 });
  const { data, loading, error, reload } = useLoad(
    () => api.auditLogs(query),
    [query.action, query.actorName, query.limit],
  );

  const exportCsv = async () => {
    try {
      const csv = await api.exportAuditLogs({
        action: query.action,
        actorName: query.actorName,
        limit: query.limit,
      });
      // 导出接口需要带鉴权头，因此不能用普通 <a href>，改为取回文本后触发 Blob 下载
      const blob = new Blob([csv], { type: 'text/csv;charset=UTF-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '导出失败');
    }
  };

  return (
    <div className="cf-page">
      <h2 className="cf-page-title">审计日志</h2>

      <Form
        layout="inline"
        style={{ marginBottom: 16 }}
        initialValues={{ limit: 100 }}
        onFinish={(values) => setQuery(values)}
      >
        <Form.Item name="action" label="动作">
          <Input placeholder="如 ORG_CREATE" allowClear style={{ width: 180 }} />
        </Form.Item>
        <Form.Item name="actorName" label="操作人">
          <Input placeholder="支持模糊匹配" allowClear style={{ width: 180 }} />
        </Form.Item>
        <Form.Item name="limit" label="条数">
          <Input type="number" style={{ width: 100 }} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              查询
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void reload()}>
              刷新
            </Button>
            <Button icon={<DownloadOutlined />} onClick={exportCsv}>
              导出 CSV
            </Button>
          </Space>
        </Form.Item>
      </Form>

      {error ? <Alert type="error" showIcon message={error.message} style={{ marginBottom: 16 }} /> : null}

      <Table<AuditLog>
        rowKey="id"
        loading={loading}
        dataSource={data ?? []}
        size="small"
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          {
            title: '时间',
            dataIndex: 'createdAt',
            width: 190,
            render: (value: string) => new Date(value).toLocaleString('zh-CN'),
          },
          { title: '操作人', dataIndex: 'actorName', width: 130 },
          {
            title: '动作',
            dataIndex: 'action',
            width: 200,
            render: (value: string) => <code>{value}</code>,
          },
          { title: '对象', width: 180, render: (_, record) => `${record.targetType ?? '—'}#${record.targetId ?? '—'}` },
          {
            title: '详情',
            dataIndex: 'detail',
            render: (value?: string) =>
              value ? (
                <Typography.Text code style={{ fontSize: 12 }}>
                  {value}
                </Typography.Text>
              ) : (
                '—'
              ),
          },
          { title: 'IP', dataIndex: 'ip', width: 140, render: (value?: string) => value ?? '—' },
        ]}
      />
    </div>
  );
}
