import { PlusOutlined } from '@ant-design/icons';
import { App as AntdApp, Alert, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import { useMemo, useState } from 'react';

import { api } from '../api';
import type { DepartmentNode, OrgMember } from '../api/types';
import { useLoad } from '../hooks/useLoad';

interface DepartmentForm {
  name: string;
  parentId?: number;
}

/**
 * 部门管理（spec §4.3）：树形增删改、设置部门负责人。
 *
 * 部门最多 5 层、路径用物化路径存储；「负责人」决定了他能在 App 里管到哪个范围（含所有下级部门）。
 */
export function OrgDepartmentsPage() {
  const { message } = AntdApp.useApp();
  const departments = useLoad<DepartmentNode[]>(() => api.orgDepartments());
  const members = useLoad<OrgMember[]>(() => api.orgMembers());
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<DepartmentNode | null>(null);
  const [parentId, setParentId] = useState<number | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<DepartmentForm>();

  const managerOptions = useMemo(
    () => (members.data ?? []).map((item) => ({ label: `${item.realName}（${item.memberKey}）`, value: item.id })),
    [members.data],
  );

  /** 后端在成员列表里带 `departmentManager`，据此还原「每个部门的负责人」。 */
  const managersByDepartment = useMemo(() => {
    const map = new Map<number, OrgMember[]>();
    for (const item of members.data ?? []) {
      if (!item.departmentManager) {
        continue;
      }
      map.set(item.departmentId, [...(map.get(item.departmentId) ?? []), item]);
    }
    return map;
  }, [members.data]);

  const openCreate = (parent?: DepartmentNode) => {
    setEditing(null);
    setParentId(parent?.id);
    form.resetFields();
    setOpen(true);
  };

  const openRename = (record: DepartmentNode) => {
    setEditing(record);
    setParentId(record.parentId);
    form.setFieldsValue({ name: record.name });
    setOpen(true);
  };

  const submit = async (values: DepartmentForm) => {
    setSubmitting(true);
    try {
      if (editing) {
        await api.updateOrgDepartment(editing.id, { name: values.name });
        message.success('部门已更新');
      } else {
        await api.createOrgDepartment({ parentId, name: values.name });
        message.success('部门已创建');
      }
      setOpen(false);
      await departments.reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const grantManager = async (departmentId: number, orgMemberId: number) => {
    try {
      await api.grantDepartmentManager(departmentId, orgMemberId);
      message.success('已设为部门负责人');
      await members.reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '设置失败');
    }
  };

  const revokeManager = async (departmentId: number, orgMemberId: number) => {
    try {
      await api.revokeDepartmentManager(departmentId, orgMemberId);
      message.success('已撤销部门负责人');
      await members.reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '撤销失败');
    }
  };

  return (
    <div className="xa-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="xa-page-title">部门管理</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
          新建根部门
        </Button>
      </div>

      {departments.error ? (
        <Alert type="error" showIcon message={departments.error.message} style={{ marginBottom: 16 }} />
      ) : null}

      <Table<DepartmentNode>
        rowKey="id"
        loading={departments.loading}
        dataSource={departments.data ?? []}
        pagination={false}
        expandable={{ defaultExpandAllRows: true }}
        columns={[
          {
            title: '部门',
            dataIndex: 'name',
            render: (value: string, record) => (
              <span>
                {value}
                <Tag bordered={false} style={{ marginLeft: 8 }}>
                  {record.level} 级
                </Tag>
              </span>
            ),
          },
          {
            title: '负责人',
            width: 320,
            render: (_, record) => (
              <Space size="small" wrap>
                {(managersByDepartment.get(record.id) ?? []).map((manager) => (
                  <Tag
                    key={manager.id}
                    bordered={false}
                    closable
                    onClose={(event) => {
                      event.preventDefault();
                      void revokeManager(record.id, manager.id);
                    }}
                  >
                    {manager.realName}
                  </Tag>
                ))}
                <Select
                  size="small"
                  style={{ width: 170 }}
                  placeholder="设为部门负责人"
                  showSearch
                  optionFilterProp="label"
                  value={undefined}
                  options={managerOptions}
                  onChange={(value: number) => void grantManager(record.id, value)}
                />
              </Space>
            ),
          },
          {
            title: '操作',
            width: 240,
            render: (_, record) => (
              <Space size="small">
                <Button
                  type="link"
                  size="small"
                  disabled={record.level >= 5}
                  onClick={() => openCreate(record)}
                >
                  加子部门
                </Button>
                <Button type="link" size="small" onClick={() => openRename(record)}>
                  改名
                </Button>
                <Popconfirm
                  title="删除该部门？"
                  description="有下级部门或成员时无法删除。"
                  onConfirm={async () => {
                    try {
                      await api.deleteOrgDepartment(record.id);
                      message.success('部门已删除');
                      await departments.reload();
                    } catch (cause) {
                      message.error(cause instanceof Error ? cause.message : '删除失败');
                    }
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
        title={editing ? '重命名部门' : parentId ? '新建子部门' : '新建根部门'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form<DepartmentForm> form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item name="name" label="部门名称" rules={[{ required: true, message: '请输入部门名称' }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
