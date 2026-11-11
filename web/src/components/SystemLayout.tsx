import { Menu } from 'antd';
import {
  AuditOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import AppHeader from './AppHeader';
import { useAuthStore } from '../stores/auth';

export default function SystemLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((state) => state.user);

  const items = [
    ...(user?.role === 'admin'
      ? [
          { key: '/users', icon: <TeamOutlined />, label: '用户与数据权限' },
          { key: '/ai-config', icon: <RobotOutlined />, label: 'AI 配置' },
        ]
      : []),
    {
      key: '/approvals',
      icon: <SafetyCertificateOutlined />,
      label: user?.role === 'admin' ? '高危操作审批' : '我的高危申请',
    },
    { key: '/logs', icon: <AuditOutlined />, label: 'AI 审核日志' },
  ];

  return (
    <div className="system-layout">
      <AppHeader mode="system" />
      <div className="system-layout__body">
        <aside className="system-sidebar">
          <div className="system-sidebar__title">系统管理</div>
          <Menu
            mode="inline"
            selectedKeys={[location.pathname]}
            items={items}
            onClick={({ key }) => navigate(key)}
          />
        </aside>
        <main className="system-layout__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
