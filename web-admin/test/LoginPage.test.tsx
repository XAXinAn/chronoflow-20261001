import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntdApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoginPage } from '../src/pages/LoginPage';
import { loadSession } from '../src/auth/session';

const loginMock = vi.fn();

vi.mock('../src/api', () => ({
  api: {
    login: (...args: unknown[]) => loginMock(...args),
  },
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

function renderLogin() {
  return render(
    <MemoryRouter>
      <AntdApp>
        <LoginPage />
      </AntdApp>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('登录页', () => {
  it('登录成功后写入会话并跳转首页', async () => {
    loginMock.mockResolvedValue({
      accessToken: 'token-abc',
      expiresIn: 7200,
      admin: { id: 1, username: 'admin', role: 'SUPER_ADMIN', status: 'ACTIVE' },
    });

    renderLogin();
    await userEvent.type(screen.getByPlaceholderText('用户名'), 'admin');
    await userEvent.type(screen.getByPlaceholderText('密码'), 'admin123456');
    // antd 会在两个中文字之间插入空格，因此用正则匹配
    await userEvent.click(screen.getByRole('button', { name: /登\s*录/ }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
    expect(loadSession()?.accessToken).toBe('token-abc');
    expect(loginMock).toHaveBeenCalledWith('admin', 'admin123456');
  });

  it('登录失败时提示错误且不写入会话', async () => {
    loginMock.mockRejectedValue(new Error('账号已锁定，请稍后再试'));

    renderLogin();
    await userEvent.type(screen.getByPlaceholderText('用户名'), 'admin');
    await userEvent.type(screen.getByPlaceholderText('密码'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /登\s*录/ }));

    await waitFor(() => expect(screen.getByText('账号已锁定，请稍后再试')).toBeInTheDocument());
    expect(loadSession()).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
