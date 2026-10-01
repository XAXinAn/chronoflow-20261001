import { App as AntdApp, Alert, Button, Descriptions, Form, Input, Space } from 'antd';
import { useEffect, useState } from 'react';

import { api } from '../api';
import type { OrgSettings } from '../api/types';
import { useLoad } from '../hooks/useLoad';

interface SettingsForm {
  name: string;
  logoUrl?: string;
  contactName?: string;
  contactPhone?: string;
  timezone?: string;
}

/**
 * 组织设置（spec §4.3）。
 *
 * 成员上限**只读**：它由平台超管控制，组织侧不能自己给自己扩容，所以这里只展示不可编辑。
 */
export function OrgSettingsPage() {
  const { message } = AntdApp.useApp();
  const { data, loading, error, reload } = useLoad<OrgSettings>(() => api.orgSettings());
  const [form] = Form.useForm<SettingsForm>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      form.setFieldsValue({
        name: data.name,
        logoUrl: data.logoUrl,
        contactName: data.contactName,
        contactPhone: data.contactPhone,
        timezone: data.timezone,
      });
    }
  }, [data, form]);

  const submit = async (values: SettingsForm) => {
    setSaving(true);
    try {
      await api.updateOrgSettings(values);
      message.success('组织设置已保存');
      await reload();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cf-page">
      <h2 className="cf-page-title">组织设置</h2>
      {error ? <Alert type="error" showIcon message={error.message} style={{ marginBottom: 16 }} /> : null}

      <Descriptions
        column={2}
        style={{ marginBottom: 16 }}
        items={[
          { key: 'code', label: '组织唯一 ID', children: <code>{data?.code ?? '—'}</code> },
          {
            key: 'members',
            label: '成员数 / 上限',
            children: `${data?.memberCount ?? 0} / ${data?.maxMembers ?? '—'}`,
          },
        ]}
      />

      <Form<SettingsForm>
        form={form}
        layout="vertical"
        onFinish={submit}
        requiredMark={false}
        disabled={loading}
        style={{ maxWidth: 520 }}
      >
        <Form.Item name="name" label="组织名称" rules={[{ required: true, message: '请输入组织名称' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="logoUrl" label="Logo 地址">
          <Input placeholder="图片 URL（选填）" />
        </Form.Item>
        <Form.Item name="contactName" label="联系人">
          <Input />
        </Form.Item>
        <Form.Item name="contactPhone" label="联系电话">
          <Input />
        </Form.Item>
        <Form.Item name="timezone" label="时区">
          <Input placeholder="例如 Asia/Shanghai" />
        </Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" loading={saving}>
            保存
          </Button>
          <Button onClick={() => void reload()}>刷新</Button>
        </Space>
      </Form>
    </div>
  );
}
