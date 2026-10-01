import { EditOutlined } from '@ant-design/icons';
import { App as AntdApp, Alert, Button, Form, Input, Modal, Table } from 'antd';
import { useState } from 'react';

import { api } from '../api';
import type { SystemConfig } from '../api/types';
import { useLoad } from '../hooks/useLoad';

export function ConfigsPage() {
  const { message } = AntdApp.useApp();
  const { data, loading, error, reload } = useLoad(() => api.configs());
  const [editing, setEditing] = useState<SystemConfig | null>(null);
  const [form] = Form.useForm<{ configValue: string; description?: string }>();

  const save = async (values: { configValue: string; description?: string }) => {
    if (!editing) {
      return;
    }
    try {
      await api.updateConfig(editing.configKey, values.configValue, values.description);
      message.success('配置已保存');
      setEditing(null);
      await reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '保存失败');
    }
  };

  return (
    <div className="cf-page">
      <h2 className="cf-page-title">全局配置</h2>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="配置值为 JSON 片段"
        description="布尔写 true，字符串写 &quot;text&quot;，对象写 {&quot;k&quot;:1}。写入前请确认格式合法。"
      />
      {error ? <Alert type="error" showIcon message={error.message} style={{ marginBottom: 16 }} /> : null}

      <Table<SystemConfig>
        rowKey="configKey"
        loading={loading}
        dataSource={data ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: '配置项', dataIndex: 'configKey', render: (value: string) => <code>{value}</code> },
          { title: '说明', dataIndex: 'description', render: (value?: string) => value ?? '—' },
          { title: '当前值', dataIndex: 'configValue' },
          {
            title: '更新时间',
            dataIndex: 'updatedAt',
            width: 200,
            render: (value?: string) => (value ? new Date(value).toLocaleString('zh-CN') : '—'),
          },
          {
            title: '操作',
            width: 100,
            render: (_, record) => (
              <Button
                type="link"
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  setEditing(record);
                  form.setFieldsValue({ configValue: record.configValue, description: record.description });
                }}
              >
                编辑
              </Button>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? `编辑配置：${editing.configKey}` : '编辑配置'}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={save} requiredMark={false}>
          <Form.Item name="configValue" label="配置值（JSON）" rules={[{ required: true, message: '请输入配置值' }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
