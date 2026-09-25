import { App as AntdApp } from 'antd';
import { useEffect } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, type RouteObject } from 'react-router-dom';

import { setUnauthorizedHandler } from './api';
import { AppLayout } from './components/AppLayout';
import { RequireAuth } from './components/RequireAuth';
import { AccountsPage } from './pages/AccountsPage';
import { AdminsPage } from './pages/AdminsPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { ConfigsPage } from './pages/ConfigsPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { OrganizationsPage } from './pages/OrganizationsPage';
import { XaThemeProvider } from './theme/ThemeProvider';

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'organizations', element: <OrganizationsPage /> },
      { path: 'accounts', element: <AccountsPage /> },
      { path: 'admins', element: <AdminsPage /> },
      { path: 'configs', element: <ConfigsPage /> },
      { path: 'audit-logs', element: <AuditLogsPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

const router = createBrowserRouter(routes);

export function App() {
  useEffect(() => {
    setUnauthorizedHandler(() => {
      globalThis.location.assign('/login');
    });
  }, []);

  return (
    <XaThemeProvider>
      <AntdApp>
        <RouterProvider router={router} />
      </AntdApp>
    </XaThemeProvider>
  );
}
