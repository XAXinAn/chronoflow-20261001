import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { App as AntdApp, Button, Card, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../api';
import { saveSession } from '../auth/session';

interface LoginForm {
  username: string;
  password: string;
}

export function LoginPage() {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [loading, setLoading] = useState(false);

  const submit = async (values: LoginForm) => {
    setLoading(true);
    try {
      const result = await api.login(values.username, values.password);
      saveSession({
        accessToken: result.accessToken,
        expiresAt: Date.now() + result.expiresIn * 1000,
        username: result.admin.username,
        role: result.admin.role,
      });
      navigate('/', { replace: true });
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--xa-bg)',
        padding: 'var(--xa-space-lg)',
      }}
    >
      <div style={{ width: 360 }}>
        <div style={{ marginBottom: 'var(--xa-space-lg)' }}>
          <Typography.Title level={2} style={{ marginBottom: 4, letterSpacing: '-0.02em' }}>
            XaTodo
          </Typography.Title>
          <Typography.Text type="secondary">心安待办 · 平台管理后台</Typography.Text>
        </div>
        <Card className="xa-card" variant="borderless" styles={{ body: { padding: 0 } }}>
          <Form<LoginForm> layout="vertical" onFinish={submit} requiredMark={false} autoComplete="off">
            <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input prefix={<UserOutlined />} placeholder="用户名" size="large" autoFocus />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" />
            </Form.Item>
            <Button type="primary" htmlType="submit" size="large" block loading={loading}>
              登录
            </Button>
          </Form>
        </Card>
      </div>
    </div>
  );
}
