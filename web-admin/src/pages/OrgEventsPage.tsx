import { PlusOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Alert,
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';

import { api } from '../api';
import type { DepartmentNode, OrgEventItem, OrgMember } from '../api/types';
import { useLoad } from '../hooks/useLoad';

const SCOPE_LABEL: Record<string, string> = {
  ALL: '全组织',
  DEPARTMENT: '部门',
  MEMBER: '指定成员',
};

function flattenDepartments(nodes: DepartmentNode[], prefix = ''): { label: string; value: number }[] {
  return nodes.flatMap((node) => {
    const label = prefix ? `${prefix}/${node.name}` : node.name;
    return [{ label, value: node.id }, ...flattenDepartments(node.children ?? [], label)];
  });
}

interface DispatchForm {
  title: string;
  description?: string;
  location?: string;
  range: [Dayjs, Dayjs];
  scopeType: string;
  departmentId?: number;
  memberIds?: number[];
}

/**
 * 组织日历管理（spec §4.3）：下发组织日程、看回执统计与明细、撤回或删除。
 *
 * 下发后会在 `event_recipient` 里展开成成员级快照，所以「谁还没回执」是确定的，
 * 不依赖成员此刻是否还在组织里。
 */
export function OrgEventsPage() {
  const { message } = AntdApp.useApp();
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('month'), dayjs().endOf('month')]);
  const events = useLoad<OrgEventItem[]>(
    () => api.orgEvents(range[0].toISOString(), range[1].toISOString()),
    [range[0].valueOf(), range[1].valueOf()],
  );
  const departments = useLoad<DepartmentNode[]>(() => api.orgDepartments());
  const members = useLoad<OrgMember[]>(() => api.orgMembers());

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<DispatchForm>();
  const scopeType = Form.useWatch('scopeType', form);

  const departmentOptions = useMemo(() => flattenDepartments(departments.data ?? []), [departments.data]);
  const memberOptions = useMemo(
    () => (members.data ?? []).map((item) => ({ label: `${item.realName}（${item.memberKey}）`, value: item.id })),
    [members.data],
  );

  const dispatch = async (values: DispatchForm) => {
    setSubmitting(true);
    try {
      await api.dispatchOrgEvent({
        title: values.title,
        description: values.description,
        location: values.location,
        startAt: values.range[0].toISOString(),
        endAt: values.range[1].toISOString(),
        scopeType: values.scopeType,
        departmentId: values.departmentId,
        includeSubDepartments: true,
        memberIds: values.memberIds,
      });
      message.success('组织日程已下发');
      setOpen(false);
      form.resetFields();
      await events.reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '下发失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="xa-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="xa-page-title">组织日历</h2>
        <Space>
          <DatePicker.RangePicker
            allowClear={false}
            value={range}
            onChange={(value) => value?.[0] && value[1] && setRange([value[0], value[1]])}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            下发日程
          </Button>
        </Space>
      </div>

      {events.error ? <Alert type="error" showIcon message={events.error.message} style={{ marginBottom: 16 }} /> : null}

      <Table<OrgEventItem>
        rowKey="eventId"
        loading={events.loading}
        dataSource={events.data ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        columns={[
          { title: '标题', dataIndex: 'title' },
          {
            title: '时间',
            width: 320,
            render: (_, record) =>
              `${dayjs(record.startAt).format('YYYY-MM-DD HH:mm')} → ${dayjs(record.endAt).format('HH:mm')}`,
          },
          {
            title: '下发范围',
            dataIndex: 'scopeType',
            width: 110,
            render: (value: string) => SCOPE_LABEL[value] ?? value,
          },
          {
            title: '收件人数',
            dataIndex: 'recipientCount',
            width: 110,
          },
          {
            title: '操作',
            width: 240,
            render: (_, record) => (
              <Space size="small">
                <Popconfirm
                  title="撤回该下发？"
                  description="已有成员回执时就撤不回来了（spec §4.2.2）。"
                  onConfirm={async () => {
                    try {
                      await api.revokeOrgEvent(record.eventId);
                      message.success('已撤回');
                      await events.reload();
                    } catch (cause) {
                      message.error(cause instanceof Error ? cause.message : '撤回失败');
                    }
                  }}
                >
                  <Button type="link" size="small">
                    撤回
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title="删除该组织日程？"
                  onConfirm={async () => {
                    try {
                      await api.deleteOrgEvent(record.eventId);
                      message.success('已删除');
                      await events.reload();
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
        title="下发组织日程"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form<DispatchForm>
          form={form}
          layout="vertical"
          onFinish={dispatch}
          requiredMark={false}
          initialValues={{ scopeType: 'ALL' }}
        >
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="range" label="起止时间" rules={[{ required: true, message: '请选择时间' }]}>
            <DatePicker.RangePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="location" label="地点">
            <Input placeholder="选填" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>
          <Form.Item name="scopeType" label="下发范围" rules={[{ required: true }]}>
            <Select
              options={[
                { label: '全组织', value: 'ALL' },
                { label: '指定部门（含下级）', value: 'DEPARTMENT' },
                { label: '指定成员', value: 'MEMBER' },
              ]}
            />
          </Form.Item>
          {scopeType === 'DEPARTMENT' ? (
            <Form.Item name="departmentId" label="部门" rules={[{ required: true, message: '请选择部门' }]}>
              <Select options={departmentOptions} showSearch optionFilterProp="label" />
            </Form.Item>
          ) : null}
          {scopeType === 'MEMBER' ? (
            <Form.Item name="memberIds" label="成员" rules={[{ required: true, message: '请选择成员' }]}>
              <Select mode="multiple" options={memberOptions} showSearch optionFilterProp="label" />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>

    </div>
  );
}
