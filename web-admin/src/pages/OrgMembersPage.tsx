import { DownloadOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Upload,
} from 'antd';
import { useMemo, useState } from 'react';

import { api } from '../api';
import type { DepartmentNode, ImportBatch, OrgMember } from '../api/types';
import { useLoad } from '../hooks/useLoad';

const ROLE_LABEL: Record<string, string> = { OWNER: '拥有者', ADMIN: '组织管理员', MEMBER: '成员' };
const STATUS_LABEL: Record<string, { text: string; color?: string }> = {
  ACTIVE: { text: '在职' },
  DISABLED: { text: '已停用', color: 'warning' },
  LEFT: { text: '已离开', color: 'default' },
};

interface MemberForm {
  memberKey: string;
  realName: string;
  departmentId: number;
  jobTitle?: string;
  orgRole?: string;
}

/** 部门树拍平成下拉选项：父级用「/」拼出来，和导入模板里的部门路径口径一致。 */
function flattenDepartments(nodes: DepartmentNode[], prefix = ''): { label: string; value: number }[] {
  return nodes.flatMap((node) => {
    const label = prefix ? `${prefix}/${node.name}` : node.name;
    return [{ label, value: node.id }, ...flattenDepartments(node.children ?? [], label)];
  });
}

/**
 * 成员管理（spec §4.3）。
 *
 * 这个页面就是新组织「开张」的入口：组织管理员用后台账号登录后，
 * 先在这里建成员/导成员，成员再拿「组织唯一 ID + 唯一识别 ID」去 App 认领。
 */
export function OrgMembersPage() {
  const { message } = AntdApp.useApp();
  const members = useLoad<OrgMember[]>(() => api.orgMembers());
  const departments = useLoad<DepartmentNode[]>(() => api.orgDepartments());
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OrgMember | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<MemberForm>();

  const importState = useImportState();
  const options = useMemo(() => flattenDepartments(departments.data ?? []), [departments.data]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (record: OrgMember) => {
    setEditing(record);
    form.setFieldsValue({
      memberKey: record.memberKey,
      realName: record.realName,
      departmentId: record.departmentId,
      jobTitle: record.jobTitle,
      orgRole: record.orgRole,
    });
    setOpen(true);
  };

  const submit = async (values: MemberForm) => {
    setSubmitting(true);
    try {
      if (editing) {
        await api.updateOrgMember(editing.id, values);
        message.success('成员已更新');
      } else {
        await api.createOrgMember(values);
        message.success('成员已新增，可让本人用「组织唯一 ID + 唯一识别 ID」在 App 里认领');
      }
      setOpen(false);
      await members.reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const changeStatus = async (record: OrgMember, status: string) => {
    try {
      await api.updateOrgMember(record.id, { status });
      message.success('成员状态已更新');
      await members.reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '操作失败');
    }
  };

  return (
    <div className="xa-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="xa-page-title">成员管理</h2>
        <Space>
          <Button icon={<UploadOutlined />} onClick={importState.open}>
            批量导入
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增成员
          </Button>
        </Space>
      </div>

      {members.error ? (
        <Alert type="error" showIcon message={members.error.message} style={{ marginBottom: 16 }} />
      ) : null}

      <Table<OrgMember>
        rowKey="id"
        loading={members.loading}
        dataSource={members.data ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: '姓名', dataIndex: 'realName', width: 140 },
          {
            title: '唯一识别 ID',
            dataIndex: 'memberKey',
            width: 160,
            render: (value: string) => <code>{value}</code>,
          },
          {
            title: '部门',
            dataIndex: 'departmentName',
            render: (value: string | undefined, record) =>
              value ? (
                <span>
                  {value}
                  {record.departmentManager ? (
                    <Tag bordered={false} style={{ marginLeft: 8 }}>
                      负责人
                    </Tag>
                  ) : null}
                </span>
              ) : (
                '—'
              ),
          },
          {
            title: '角色',
            dataIndex: 'orgRole',
            width: 120,
            render: (value: string) => ROLE_LABEL[value] ?? value,
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 110,
            render: (value: string) => {
              const label = STATUS_LABEL[value] ?? { text: value };
              return <Tag color={label.color} bordered={false}>{label.text}</Tag>;
            },
          },
          {
            title: '组织账号',
            dataIndex: 'bound',
            width: 120,
            render: (bound: boolean) =>
              bound ? (
                <Tag bordered={false}>已认领</Tag>
              ) : (
                <Tag bordered={false} color="warning">
                  待认领
                </Tag>
              ),
          },
          {
            title: '操作',
            width: 220,
            render: (_, record) => (
              <Space size="small">
                <Button type="link" size="small" onClick={() => openEdit(record)}>
                  编辑
                </Button>
                {record.status === 'ACTIVE' ? (
                  <Button type="link" size="small" onClick={() => changeStatus(record, 'DISABLED')}>
                    停用
                  </Button>
                ) : (
                  <Button type="link" size="small" onClick={() => changeStatus(record, 'ACTIVE')}>
                    启用
                  </Button>
                )}
                {record.bound ? (
                  <Popconfirm
                    title="解绑该成员的组织账号？"
                    description="成员记录保留，成员可用同样凭据重新认领。"
                    onConfirm={async () => {
                      try {
                        await api.unbindOrgMember(record.id);
                        message.success('已解绑，成员可以重新认领');
                        await members.reload();
                      } catch (cause) {
                        message.error(cause instanceof Error ? cause.message : '解绑失败');
                      }
                    }}
                  >
                    <Button type="link" size="small" danger>
                      解绑
                    </Button>
                  </Popconfirm>
                ) : null}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editing ? '编辑成员' : '新增成员'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form<MemberForm> form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item
            name="realName"
            label="姓名"
            rules={[{ required: true, message: '请输入姓名' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="memberKey"
            label="成员唯一识别 ID"
            extra="学号 / 工号。它就是成员在 App 里认领组织账号的凭据，组织内唯一。"
            rules={[{ required: true, message: '请输入成员唯一识别 ID' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="departmentId"
            label="部门"
            rules={[{ required: true, message: '请选择部门' }]}
          >
            <Select
              options={options}
              showSearch
              optionFilterProp="label"
              placeholder={options.length ? '选择部门' : '请先在「部门管理」里建部门'}
            />
          </Form.Item>
          <Form.Item name="jobTitle" label="职位">
            <Input placeholder="选填" />
          </Form.Item>
          <Form.Item name="orgRole" label="组织角色">
            <Select
              allowClear
              placeholder="默认普通成员"
              options={[
                { label: '普通成员', value: 'MEMBER' },
                { label: '组织管理员', value: 'ADMIN' },
                { label: '拥有者', value: 'OWNER' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <BatchImportModal state={importState} onImported={() => void members.reload()} />
    </div>
  );
}

function useImportState() {
  const [visible, setVisible] = useState(false);
  return {
    visible,
    open: () => setVisible(true),
    close: () => setVisible(false),
  };
}

function BatchImportModal({
  state,
  onImported,
}: {
  state: ReturnType<typeof useImportState>;
  onImported: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [file, setFile] = useState<File | null>(null);
  const [autoCreate, setAutoCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportBatch | null>(null);
  const [history, setHistory] = useState<ImportBatch[]>([]);

  const loadHistory = async () => {
    try {
      setHistory(await api.orgImports());
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '导入记录加载失败');
    }
  };

  const start = async () => {
    if (!file) {
      message.warning('请先选择 .xlsx 或 .csv 文件');
      return;
    }
    setBusy(true);
    try {
      const created = await api.importOrgMembers(file, autoCreate);
      setResult(created);
      message.success(`已提交导入，共 ${created.totalCount} 行`);
      await loadHistory();
      onImported();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  const download = async (loader: () => Promise<Blob>, filename: string) => {
    try {
      const blob = await loader();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '下载失败');
    }
  };

  return (
    <Modal
      title="批量导入成员"
      open={state.visible}
      width={760}
      onCancel={state.close}
      onOk={() => void start()}
      okText="开始导入"
      confirmLoading={busy}
      destroyOnHidden
      afterOpenChange={(open) => {
        if (open) {
          void loadHistory();
        }
      }}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="模板列：姓名、成员唯一识别 ID（学号/工号）、部门路径、角色"
        description="部门路径是从组织根开始的绝对路径（如「技术中心/后端组」）。手机号、邮箱不再需要。"
      />
      <Space style={{ marginBottom: 16 }} wrap>
        <Upload
          accept=".xlsx,.csv"
          maxCount={1}
          beforeUpload={(selected) => {
            setFile(selected as unknown as File);
            return false;
          }}
          onRemove={() => setFile(null)}
        >
          <Button icon={<UploadOutlined />}>选择文件</Button>
        </Upload>
        <span>自动创建不存在的部门</span>
        <Switch checked={autoCreate} onChange={setAutoCreate} />
        <Button
          icon={<DownloadOutlined />}
          onClick={() => void download(() => api.orgImportTemplate(), 'member-import-template.xlsx')}
        >
          下载模板
        </Button>
      </Space>

      {result ? (
        <>
          <Alert
            type={result.failCount === 0 ? 'success' : 'warning'}
            showIcon
            style={{ marginBottom: 12 }}
            message={`共 ${result.totalCount} 行：成功 ${result.successCount}，失败 ${result.failCount}（${result.status}）`}
            action={
              result.failCount > 0 ? (
                <Button
                  size="small"
                  onClick={() =>
                    void download(
                      () => api.orgImportFailures(result.batchId).then((csv) => new Blob([csv])),
                      `import-failures-${result.batchId}.csv`,
                    )
                  }
                >
                  下载失败明细
                </Button>
              ) : null
            }
          />
          <Table
            rowKey="rowNo"
            size="small"
            pagination={false}
            scroll={{ y: 220 }}
            dataSource={result.rows ?? []}
            columns={[
              { title: '行号', dataIndex: 'rowNo', width: 70 },
              {
                title: '结果',
                dataIndex: 'status',
                width: 90,
                render: (value: string) =>
                  value === 'SUCCESS' ? (
                    <Tag bordered={false}>成功</Tag>
                  ) : (
                    <Tag bordered={false} color="error">
                      失败
                    </Tag>
                  ),
              },
              { title: '原因', dataIndex: 'errorMessage' },
            ]}
          />
        </>
      ) : null}

      {history.length ? (
        <Table<ImportBatch>
          style={{ marginTop: 16 }}
          rowKey="batchId"
          size="small"
          pagination={false}
          dataSource={history}
          columns={[
            { title: '批次', dataIndex: 'batchId', width: 80 },
            { title: '文件', dataIndex: 'fileName' },
            { title: '状态', dataIndex: 'status', width: 140 },
            {
              title: '成功 / 失败',
              width: 120,
              render: (_, record) => `${record.successCount} / ${record.failCount}`,
            },
          ]}
        />
      ) : null}
    </Modal>
  );
}
