import {
  AuditOutlined,
  BankOutlined,
  DashboardOutlined,
  LogoutOutlined,
  MoonOutlined,
  SettingOutlined,
  SunOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Button, Layout, Menu, Space, Tag, Typography } from 'antd';
import { useMemo } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { clearSession, loadSession } from '../auth/session';
import { useXaTheme } from '../theme/ThemeProvider';

const { Header, Sider, Content } = Layout;

const MENU = [
  { key: '/', icon: <DashboardOutlined />, label: '数据看板' },
  { key: '/organizations', icon: <BankOutlined />, label: '组织管理' },
  { key: '/accounts', icon: <UserOutlined />, label: '账号管理' },
  { key: '/admins', icon: <TeamOutlined />, label: '后台管理员' },
  { key: '/configs', icon: <SettingOutlined />, label: '全局配置' },
  { key: '/audit-logs', icon: <AuditOutlined />, label: '审计日志' },
];

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { scheme, toggle } = useXaTheme();
  const session = useMemo(() => loadSession(), []);

  const selectedKey = MENU.find((item) => item.key === location.pathname)?.key ?? '/';

  const logout = () => {
    clearSession();
    navigate('/login', { replace: true });
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme={scheme} width={208} style={{ borderRight: '1px solid var(--xa-border)' }}>
        <div style={{ padding: '20px 16px 12px' }}>
          <Typography.Text strong style={{ fontSize: 16, letterSpacing: '-0.02em' }}>
            XaTodo
          </Typography.Text>
          <div className="xa-metric-label">心安待办 · 平台后台</div>
        </div>
        <Menu
          theme={scheme}
          mode="inline"
          selectedKeys={[selectedKey]}
          items={MENU}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: 'var(--xa-bg)',
            borderBottom: '1px solid var(--xa-border)',
            paddingInline: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span />
          <Space size="middle">
            <Tag bordered={false}>{session?.role === 'SUPER_ADMIN' ? '平台超管' : '组织管理员'}</Tag>
            <Typography.Text type="secondary">{session?.username}</Typography.Text>
            <Button
              type="text"
              aria-label="切换深浅色"
              icon={scheme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
              onClick={toggle}
            />
            <Button type="text" icon={<LogoutOutlined />} onClick={logout}>
              退出
            </Button>
          </Space>
        </Header>
        <Content>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
