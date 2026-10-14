import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntdApp, Alert, Button, Form, Input, Modal, Popconfirm, Space, Switch, Table, Tag } from 'antd';
import { useState } from 'react';

import { api } from '../api';
import type { SystemConfig } from '../api/types';
import { useLoad } from '../hooks/useLoad';

/**
 * 全局配置里**已知且真正被消费**的键。它们不是普通键值，而是 App 的功能开关：
 * 超管在这里关掉，「意见反馈 / 实名认证 / 邮箱绑定 / 小安」入口在 App 里就会消失
 * （App 读 `GET /api/v1/system/features`），改完不用发版。所以这几个渲染成开关，
 * 而不是让超管手写 `true` / `false` 的 JSON —— 手写一次拼错就没有任何提示。
 */
const FEATURE_FLAGS: Record<string, { label: string; hint: string }> = {
  'feature.feedback.enabled': {
    label: '意见反馈入口',
    hint: '关掉后 App「我的 → 支持」里不再显示意见反馈',
  },
  'feature.realname.enabled': {
    label: '实名认证入口',
    hint: '关掉后 App 不显示实名认证（CloudAuth 按次计费，演示环境可关）',
  },
  'feature.email_binding.enabled': {
    label: '邮箱绑定入口',
    hint: '关掉后 App 不显示邮箱绑定 / 换绑入口',
  },
  'feature.agent.enabled': {
    label: '小安（智能助手）',
    hint: '关掉后 App 不显示小安入口（模型没额度时可关）',
  },
};

/** 配置值在库里是 jsonb，读出来是 JSON 文本；判断开关状态时把 `true` / `"true"` 都算真。 */
function isOn(value: string | undefined): boolean {
  const text = (value ?? '').trim();
  return text === 'true' || text === '"true"';
}

export function ConfigsPage() {
  const { message } = AntdApp.useApp();
  const { data, loading, error, reload } = useLoad(() => api.configs());
  const [editing, setEditing] = useState<SystemConfig | null>(null);
  const [creating, setCreating] = useState(false);
  const [savingFlag, setSavingFlag] = useState<string | null>(null);
  const [form] = Form.useForm<{ configKey?: string; configValue: string; description?: string }>();

  const openCreate = () => {
    setCreating(true);
    form.resetFields();
  };

  const openEdit = (record: SystemConfig) => {
    setEditing(record);
    form.setFieldsValue({ configValue: record.configValue, description: record.description });
  };

  const closeModal = () => {
    setEditing(null);
    setCreating(false);
  };

  const save = async (values: { configKey?: string; configValue: string; description?: string }) => {
    const key = creating ? (values.configKey ?? '').trim() : editing?.configKey;
    if (!key) {
      message.error('请填写配置项名称');
      return;
    }
    try {
      await api.updateConfig(key, values.configValue, values.description);
      message.success('配置已保存');
      closeModal();
      await reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '保存失败');
    }
  };

  /** 开关直接写 true / false，说明沿用库里已有的那条，不要把超管写的说明冲掉。 */
  const toggleFlag = async (record: SystemConfig, next: boolean) => {
    setSavingFlag(record.configKey);
    try {
      await api.updateConfig(record.configKey, next ? 'true' : 'false', record.description);
      message.success(next ? '已开启，App 下次进入即可见' : '已关闭，App 下次进入即可见');
      await reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSavingFlag(null);
    }
  };

  const remove = async (record: SystemConfig) => {
    try {
      await api.deleteConfig(record.configKey);
      message.success('配置已删除');
      await reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '删除失败');
    }
  };

  return (
    <div className="cf-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="cf-page-title">全局配置</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建配置
        </Button>
      </div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="上面四个开关改完即时生效（App 重新进入对应页面即可见）"
        description="其余配置项的值是 JSON 片段：布尔写 true，字符串写 &quot;text&quot;，对象写 {&quot;k&quot;:1}。写入前请确认格式合法；删除后读取方回到默认值（开关默认开启）。"
      />
      {error ? <Alert type="error" showIcon message={error.message} style={{ marginBottom: 16 }} /> : null}

      <Table<SystemConfig>
        rowKey="configKey"
        loading={loading}
        dataSource={data ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          {
            title: '配置项',
            dataIndex: 'configKey',
            render: (value: string) => (
              <Space size={6}>
                <code>{value}</code>
                {FEATURE_FLAGS[value] ? <Tag bordered={false} color="blue">功能开关</Tag> : null}
              </Space>
            ),
          },
          {
            title: '说明',
            dataIndex: 'description',
            render: (value: string | undefined, record) => value ?? FEATURE_FLAGS[record.configKey]?.hint ?? '—',
          },
          {
            title: '当前值',
            dataIndex: 'configValue',
            render: (value: string, record) =>
              FEATURE_FLAGS[record.configKey] ? (
                <Switch
                  checked={isOn(value)}
                  loading={savingFlag === record.configKey}
                  checkedChildren="开"
                  unCheckedChildren="关"
                  onChange={(next) => void toggleFlag(record, next)}
                />
              ) : (
                <code>{value}</code>
              ),
          },
          {
            title: '更新时间',
            dataIndex: 'updatedAt',
            width: 200,
            render: (value?: string) => (value ? new Date(value).toLocaleString('zh-CN') : '—'),
          },
          {
            title: '操作',
            width: 150,
            render: (_, record) => (
              <Space size="small">
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
                  编辑
                </Button>
                <Popconfirm
                  title="删除该配置项？"
                  description="删除后读取方回到默认值（功能开关默认开启）。"
                  onConfirm={() => void remove(record)}
                >
                  <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={creating ? '新建配置' : editing ? `编辑配置：${editing.configKey}` : '编辑配置'}
        open={creating || editing !== null}
        onCancel={closeModal}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={save} requiredMark={false}>
          {creating ? (
            <Form.Item
              name="configKey"
              label="配置项名称"
              extra="建议使用「域.对象.属性」形式，例如 feature.xxx.enabled"
              rules={[{ required: true, message: '请输入配置项名称' }]}
            >
              <Input placeholder="feature.new_flag.enabled" />
            </Form.Item>
          ) : null}
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
