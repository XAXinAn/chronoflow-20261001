import {
  AuditOutlined,
  BankOutlined,
  CalendarOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  LogoutOutlined,
  MessageOutlined,
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

/** 平台超管的菜单（spec §4.4）。 */
const SUPER_ADMIN_MENU = [
  { key: '/', icon: <DashboardOutlined />, label: '数据看板' },
  { key: '/organizations', icon: <BankOutlined />, label: '组织管理' },
  { key: '/accounts', icon: <UserOutlined />, label: '账号管理' },
  { key: '/admins', icon: <TeamOutlined />, label: '后台管理员' },
  { key: '/feedback', icon: <MessageOutlined />, label: '意见反馈' },
  { key: '/configs', icon: <SettingOutlined />, label: '全局配置' },
  { key: '/audit-logs', icon: <AuditOutlined />, label: '审计日志' },
];

/**
 * 组织管理端的菜单（spec §4.3）。
 *
 * 组织管理员（`admin_user`，带 `org_id`）登录后看到的是这一套——这也正是新组织
 * 「建部门 → 导成员」的唯一入口：此时组织里还没有任何成员，成员侧的入口还无从谈起。
 */
const ORG_ADMIN_MENU = [
  { key: '/org/settings', icon: <SettingOutlined />, label: '组织设置' },
  { key: '/org/members', icon: <UserOutlined />, label: '成员管理' },
  { key: '/org/departments', icon: <DeploymentUnitOutlined />, label: '部门管理' },
  { key: '/org/events', icon: <CalendarOutlined />, label: '组织日历' },
  { key: '/org/logs', icon: <AuditOutlined />, label: '操作日志' },
];

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { scheme, toggle } = useXaTheme();
  const session = useMemo(() => loadSession(), []);
  const menu = session?.role === 'ORG_ADMIN' ? ORG_ADMIN_MENU : SUPER_ADMIN_MENU;

  const selectedKey = menu.find((item) => item.key === location.pathname)?.key ?? menu[0].key;

  const logout = () => {
    clearSession();
    navigate('/login', { replace: true });
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme={scheme} width={208} style={{ borderRight: '1px solid var(--xa-border)' }}>
        <div style={{ padding: '20px 16px 12px' }}>
          <Typography.Text strong style={{ fontSize: 16, letterSpacing: '-0.02em' }}>
            时纪流
          </Typography.Text>
          <div className="xa-metric-label">时纪流 · 平台后台</div>
        </div>
        <Menu
          theme={scheme}
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menu}
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
