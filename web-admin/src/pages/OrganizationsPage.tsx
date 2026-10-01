import { PlusOutlined } from '@ant-design/icons';
import { App as AntdApp, Alert, Button, Form, Input, InputNumber, Modal, Popconfirm, Space, Table, Tag } from 'antd';
import { useState } from 'react';

import { api } from '../api';
import type { Organization } from '../api/types';
import { useLoad } from '../hooks/useLoad';

const STATUS_LABEL: Record<string, { text: string; color?: string }> = {
  ACTIVE: { text: '启用' },
  SUSPENDED: { text: '停用', color: 'warning' },
  DISABLED: { text: '禁用', color: 'error' },
};

interface CreateForm {
  name: string;
  code: string;
  maxMembers?: number;
  adminUsername: string;
  adminPassword: string;
  adminRealName?: string;
  ownerMemberKey?: string;
  ownerRealName?: string;
}

export function OrganizationsPage() {
  const { message } = AntdApp.useApp();
  const { data, loading, error, reload } = useLoad(() => api.organizations());
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<CreateForm>();

  const create = async (values: CreateForm) => {
    setSubmitting(true);
    try {
      await api.createOrganization(values);
      message.success('组织已创建，首位管理员可立即登录后台');
      setOpen(false);
      form.resetFields();
      await reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const changeStatus = async (record: Organization, status: string) => {
    try {
      await api.changeOrganizationStatus(record.id, status);
      message.success('状态已更新');
      await reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '操作失败');
    }
  };

  return (
    <div className="cf-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="cf-page-title">组织管理</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          新建组织
        </Button>
      </div>

      {error ? <Alert type="error" showIcon message={error.message} style={{ marginBottom: 16 }} /> : null}

      <Table<Organization>
        rowKey="id"
        loading={loading}
        dataSource={data ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: '组织名称', dataIndex: 'name' },
          { title: '编码', dataIndex: 'code', render: (value: string) => <code>{value}</code> },
          {
            title: '状态',
            dataIndex: 'status',
            render: (value: string) => {
              const label = STATUS_LABEL[value] ?? { text: value };
              return <Tag color={label.color} bordered={false}>{label.text}</Tag>;
            },
          },
          { title: '成员上限', dataIndex: 'maxMembers', width: 110 },
          { title: '时区', dataIndex: 'timezone', width: 160 },
          {
            title: '操作',
            width: 220,
            render: (_, record) => (
              <Space size="small">
                {record.status === 'ACTIVE' ? (
                  <Button type="link" size="small" onClick={() => changeStatus(record, 'SUSPENDED')}>
                    停用
                  </Button>
                ) : (
                  <Button type="link" size="small" onClick={() => changeStatus(record, 'ACTIVE')}>
                    启用
                  </Button>
                )}
                <Popconfirm
                  title="确认删除该组织？"
                  description="删除后该组织将不可访问，成员无法继续使用。"
                  onConfirm={async () => {
                    await api.deleteOrganization(record.id);
                    message.success('已删除');
                    await reload();
                  }}
                >
                  <Button type="link" size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title="新建组织"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form<CreateForm> form={form} layout="vertical" onFinish={create} requiredMark={false}>
          <Form.Item name="name" label="组织名称" rules={[{ required: true, message: '请输入组织名称' }]}>
            <Input placeholder="例如：心安科技" />
          </Form.Item>
          <Form.Item name="code" label="组织编码" rules={[{ required: true, message: '请输入组织编码' }]}>
            <Input placeholder="例如：XAKJ（全局唯一）" />
          </Form.Item>
          <Form.Item name="maxMembers" label="成员上限">
            <InputNumber min={1} style={{ width: '100%' }} placeholder="默认 100" />
          </Form.Item>
          <Form.Item
            name="adminUsername"
            label="首位管理员用户名"
            rules={[{ required: true, min: 3, message: '至少 3 个字符' }]}
          >
            <Input placeholder="组织管理员登录用户名" />
          </Form.Item>
          <Form.Item
            name="adminPassword"
            label="首位管理员密码"
            rules={[{ required: true, min: 8, message: '密码至少 8 位' }]}
          >
            <Input.Password placeholder="至少 8 位" />
          </Form.Item>
          <Form.Item name="adminRealName" label="管理员姓名">
            <Input placeholder="选填" />
          </Form.Item>
          {/* 选填：预置首位拥有者（spec §3.4）。填了组织一建好就能在 App 里被认领，
              不用先进后台手动建「总部」再加人 */}
          <Form.Item
            name="ownerMemberKey"
            label="首位拥有者唯一识别 ID"
            tooltip="选填。填了就同时建「总部」根部门与一条拥有者成员记录；成员在 App「组织 → 账户管理」里用它认领组织账号"
          >
            <Input placeholder="学号 / 工号，例如 2023210704127" />
          </Form.Item>
          <Form.Item name="ownerRealName" label="拥有者姓名">
            <Input placeholder="选填，默认用上面的唯一识别 ID" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
