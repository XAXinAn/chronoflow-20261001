import { render, screen } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgMembersPage } from '../src/pages/OrgMembersPage';

const membersMock = vi.fn();
const departmentsMock = vi.fn();

vi.mock('../src/api', () => ({
  api: {
    orgMembers: (...args: unknown[]) => membersMock(...args),
    orgDepartments: (...args: unknown[]) => departmentsMock(...args),
    orgImports: () => Promise.resolve([]),
  },
  resolveApiAssetUrl: (path: string) => path,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('组织成员管理页', () => {
  it('列出成员并标出还没认领组织账号的人', async () => {
    membersMock.mockResolvedValue([
      {
        id: 1,
        bound: true,
        departmentId: 10,
        departmentName: '技术中心',
        realName: '王思远',
        memberKey: 'E1001',
        orgRole: 'ADMIN',
        status: 'ACTIVE',
        departmentManager: true,
      },
      {
        id: 2,
        bound: false,
        departmentId: 10,
        departmentName: '技术中心',
        realName: '李四',
        memberKey: 'E1002',
        orgRole: 'MEMBER',
        status: 'ACTIVE',
        departmentManager: false,
      },
    ]);
    departmentsMock.mockResolvedValue([{ id: 10, name: '技术中心', level: 1, path: '/10/', children: [] }]);

    render(
      <MemoryRouter>
        <AntdApp>
          <OrgMembersPage />
        </AntdApp>
      </MemoryRouter>,
    );

    expect(await screen.findByText('王思远')).toBeInTheDocument();
    expect(screen.getByText('李四')).toBeInTheDocument();
    expect(screen.getByText('已认领')).toBeInTheDocument();
    expect(screen.getByText('待认领')).toBeInTheDocument();
    // 新组织「开张」的两个入口要一直在
    expect(screen.getByRole('button', { name: /批量导入/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新增成员/ })).toBeInTheDocument();
  });
});
