import { PlusOutlined } from '@ant-design/icons';
import { App as AntdApp, Alert, Button, Form, Input, InputNumber, Modal, Select, Space, Table, Tag } from 'antd';
import { useState } from 'react';

import { api } from '../api';
import type { AdminInfo } from '../api/types';
import { useLoad } from '../hooks/useLoad';

interface CreateForm {
  username: string;
  password: string;
  realName?: string;
  role: 'SUPER_ADMIN' | 'ORG_ADMIN';
  orgId?: number;
}

export function AdminsPage() {
  const { message } = AntdApp.useApp();
  const { data, loading, error, reload } = useLoad(() => api.admins());
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<CreateForm>();
  const role = Form.useWatch('role', form);

  const create = async (values: CreateForm) => {
    setSubmitting(true);
    try {
      await api.createAdmin(values);
      message.success('管理员已创建');
      setOpen(false);
      form.resetFields();
      await reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const resetPassword = (record: AdminInfo) => {
    let password = '';
    Modal.confirm({
      title: `重置 ${record.username} 的密码`,
      content: (
        <Input.Password placeholder="新密码（至少 8 位）" onChange={(event) => (password = event.target.value)} />
      ),
      onOk: async () => {
        if (password.length < 8) {
          message.error('密码至少 8 位');
          return Promise.reject(new Error('密码太短'));
        }
        await api.resetAdminPassword(record.id, password);
        message.success('密码已重置，同时解除锁定');
      },
    });
  };

  const toggleStatus = async (record: AdminInfo) => {
    try {
      await api.updateAdmin(record.id, { status: record.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' });
      message.success('状态已更新');
      await reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '操作失败');
    }
  };

  return (
    <div className="xa-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="xa-page-title">后台管理员</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          新建管理员
        </Button>
      </div>

      {error ? <Alert type="error" showIcon message={error.message} style={{ marginBottom: 16 }} /> : null}

      <Table<AdminInfo>
        rowKey="id"
        loading={loading}
        dataSource={data ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: '用户名', dataIndex: 'username' },
          { title: '姓名', dataIndex: 'realName', render: (value?: string) => value ?? '—' },
          {
            title: '角色',
            dataIndex: 'role',
            width: 140,
            render: (value: string) => (
              <Tag bordered={false}>{value === 'SUPER_ADMIN' ? '平台超管' : '组织管理员'}</Tag>
            ),
          },
          { title: '所属组织', dataIndex: 'orgId', width: 120, render: (value?: number) => value ?? '—' },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (value: string) => (
              <Tag bordered={false} color={value === 'ACTIVE' ? undefined : 'error'}>
                {value === 'ACTIVE' ? '正常' : '已停用'}
              </Tag>
            ),
          },
          {
            title: '操作',
            width: 200,
            render: (_, record) => (
              <Space size="small">
                <Button type="link" size="small" onClick={() => resetPassword(record)}>
                  重置密码
                </Button>
                <Button type="link" size="small" danger={record.status === 'ACTIVE'} onClick={() => toggleStatus(record)}>
                  {record.status === 'ACTIVE' ? '停用' : '启用'}
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title="新建管理员"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form<CreateForm> form={form} layout="vertical" onFinish={create} requiredMark={false} initialValues={{ role: 'SUPER_ADMIN' }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, min: 3, message: '至少 3 个字符' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 8, message: '密码至少 8 位' }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="realName" label="姓名">
            <Input placeholder="选填" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'SUPER_ADMIN', label: '平台超管' },
                { value: 'ORG_ADMIN', label: '组织管理员' },
              ]}
            />
          </Form.Item>
          {role === 'ORG_ADMIN' ? (
            <Form.Item name="orgId" label="所属组织 ID" rules={[{ required: true, message: '组织管理员必须绑定组织' }]}>
              <InputNumber min={1} style={{ width: '100%' }} />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>
    </div>
  );
}
