import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Dropdown, Segmented, Tag, Typography } from 'antd';
import type { MenuProps } from 'antd';
import {
  DatabaseOutlined,
  KeyOutlined,
  LogoutOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import BrandLogo from './BrandLogo';
import ChangePasswordModal from './ChangePasswordModal';
import { api, type SysConfig } from '../api';
import { useAuthStore } from '../stores/auth';

export type AppMode = 'database' | 'system';

export default function AppHeader({ mode }: { mode: AppMode }) {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [sysConfig, setSysConfig] = useState<SysConfig | null>(null);

  useEffect(() => {
    let active = true;
    api.get('/system/config')
      .then(({ data }) => active && setSysConfig(data))
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const accountMenu: MenuProps = {
    items: [
      { key: 'password', icon: <KeyOutlined />, label: '修改密码' },
      { type: 'divider' },
      { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
    ],
    onClick: ({ key }) => {
      if (key === 'password') setPasswordOpen(true);
      if (key === 'logout') {
        logout();
        navigate('/login');
      }
    },
  };

  const switchMode = (nextMode: string | number) => {
    if (nextMode === 'database') {
      navigate('/');
      return;
    }
    navigate(user?.role === 'admin' ? '/users' : '/approvals');
  };

  return (
    <>
      <header className="workspace-header">
        <div className="workspace-brand">
          <BrandLogo size={26} color="#275c9f" />
          <Typography.Text strong className="workspace-brand-name">DataX</Typography.Text>
          <Typography.Text className="workspace-brand-subtitle">
            {mode === 'database' ? '数据库操作' : '系统管理'}
          </Typography.Text>
        </div>

        <div className="workspace-header-right">
          <Tag
            color={sysConfig?.aiEnabled ? 'green' : 'default'}
            title={sysConfig?.aiEnabled && sysConfig.aiModel ? `当前 AI 模型：${sysConfig.aiModel}` : undefined}
          >
            {sysConfig?.aiEnabled
              ? `AI 审核 · ${sysConfig.aiModel ?? '模型未配置'}`
              : '规则审核'}
          </Tag>
          <Segmented
            value={mode}
            onChange={switchMode}
            options={[
              { label: '数据库操作', value: 'database', icon: <DatabaseOutlined /> },
              { label: '系统管理', value: 'system', icon: <SettingOutlined /> },
            ]}
          />
          <Dropdown menu={accountMenu}>
            <div className="workspace-user-trigger">
              <Avatar size={30} className="workspace-user-avatar">
                {(user?.username ?? 'U').charAt(0).toUpperCase()}
              </Avatar>
              <span className="workspace-user-name">{user?.username}</span>
              <span className="workspace-user-role">{user?.role === 'admin' ? '管理员' : '用户'}</span>
            </div>
          </Dropdown>
        </div>
      </header>
      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </>
  );
}
