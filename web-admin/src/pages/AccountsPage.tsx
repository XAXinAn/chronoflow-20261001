import { SearchOutlined } from '@ant-design/icons';
import { App as AntdApp, Alert, Button, Form, Input, Space, Table, Tag } from 'antd';
import { useState } from 'react';

import { api } from '../api';
import type { Account, AccountIdentity } from '../api/types';
import { useLoad } from '../hooks/useLoad';

export function AccountsPage() {
  const { message } = AntdApp.useApp();
  const [query, setQuery] = useState<{ phone?: string; status?: string }>({});
  const { data, loading, error, reload } = useLoad(
    () => api.accounts({ ...query, limit: 100 }),
    [query.phone, query.status],
  );

  const changeStatus = async (record: Account, status: string) => {
    try {
      await api.changeAccountStatus(record.accountId, status);
      message.success(status === 'DISABLED' ? '已封禁，该账号会话已失效' : '已解封');
      await reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '操作失败');
    }
  };

  const forceLogout = async (record: Account) => {
    try {
      await api.forceLogout(record.accountId);
      message.success('已强制登出');
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '操作失败');
    }
  };

  return (
    <div className="cf-page">
      <h2 className="cf-page-title">账号管理</h2>

      <Form
        layout="inline"
        style={{ marginBottom: 16 }}
        onFinish={(values: { phone?: string; status?: string }) => setQuery(values)}
      >
        <Form.Item name="phone" label="手机号">
          <Input placeholder="支持模糊匹配" allowClear style={{ width: 200 }} />
        </Form.Item>
        <Form.Item name="status" label="状态">
          <Input placeholder="ACTIVE / DISABLED" allowClear style={{ width: 180 }} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
              查询
            </Button>
            <Button
              onClick={() => {
                setQuery({});
              }}
            >
              重置
            </Button>
          </Space>
        </Form.Item>
      </Form>

      {error ? <Alert type="error" showIcon message={error.message} style={{ marginBottom: 16 }} /> : null}

      <Table<Account>
        rowKey="accountId"
        loading={loading}
        dataSource={data ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        expandable={{
          expandedRowRender: (record) => (
            <Table<AccountIdentity>
              rowKey="identityId"
              size="small"
              pagination={false}
              dataSource={record.identities}
              columns={[
                { title: '身份类型', dataIndex: 'identityType' },
                { title: '所属组织', dataIndex: 'orgName', render: (value?: string) => value ?? '—' },
                { title: '昵称', dataIndex: 'nickname' },
                {
                  title: '状态',
                  dataIndex: 'status',
                  render: (value: string) => (
                    <Tag bordered={false} color={value === 'ACTIVE' ? undefined : 'error'}>
                      {value === 'ACTIVE' ? '正常' : '已停用'}
                    </Tag>
                  ),
                },
                {
                  title: '操作',
                  width: 120,
                  render: (_, identity) => (
                    <Button
                      type="link"
                      size="small"
                      onClick={async () => {
                        await api.changeIdentityStatus(
                          identity.identityId,
                          identity.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
                        );
                        await reload();
                      }}
                    >
                      {identity.status === 'ACTIVE' ? '停用身份' : '恢复身份'}
                    </Button>
                  ),
                },
              ]}
            />
          ),
        }}
        columns={[
          { title: '手机号', dataIndex: 'phone' },
          { title: '邮箱', dataIndex: 'email', render: (value?: string) => value ?? '—' },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (value: string) => (
              <Tag bordered={false} color={value === 'ACTIVE' ? undefined : 'error'}>
                {value === 'ACTIVE' ? '正常' : '已封禁'}
              </Tag>
            ),
          },
          { title: '身份数', width: 90, render: (_, record) => record.identities.length },
          {
            title: '最近登录',
            dataIndex: 'lastLoginAt',
            width: 200,
            render: (value?: string) => (value ? new Date(value).toLocaleString('zh-CN') : '—'),
          },
          {
            title: '操作',
            width: 200,
            render: (_, record) => (
              <Space size="small">
                <Button
                  type="link"
                  size="small"
                  danger={record.status === 'ACTIVE'}
                  onClick={() => changeStatus(record, record.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')}
                >
                  {record.status === 'ACTIVE' ? '封禁' : '解封'}
                </Button>
                <Button type="link" size="small" onClick={() => forceLogout(record)}>
                  强制登出
                </Button>
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
}
