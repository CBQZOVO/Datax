import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import SystemLayout from './components/SystemLayout';
import { Spin } from 'antd';
import { useAuthStore } from './stores/auth';
import LoginPage from './pages/Login';
import WorkspacePage from './pages/Workspace';
import AuditLogPage from './pages/AuditLog';
import UserManagementPage from './pages/UserManagement';
import ApprovalsPage from './pages/Approvals';
import AiConfigPage from './pages/AiConfig';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token, user, fetchMe } = useAuthStore();
  const location = useLocation();

  useEffect(() => {
    if (token && !user) void fetchMe().catch(() => useAuthStore.getState().logout());
  }, [token, user, fetchMe]);

  if (!token) return <Navigate to="/login" replace />;
  if (!user) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" tip="加载中..." />
      </div>
    );
  }
  if (user.mustChangePassword === 1 && !location.pathname.startsWith('/force-password')) {
    return <Navigate to="/force-password" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/force-password"
        element={
          <RequireAuth>
            <WorkspacePage forcePassword />
          </RequireAuth>
        }
      />
      <Route
        path="/"
        element={
          <RequireAuth>
            <WorkspacePage />
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <SystemLayout />
          </RequireAuth>
        }
      >
        <Route path="/users" element={<UserManagementPage />} />
        <Route path="/ai-config" element={<AiConfigPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/logs" element={<AuditLogPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
