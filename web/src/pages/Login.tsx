import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Form, Input, App } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import BrandLogo from '../components/BrandLogo';
import { useAuthStore } from '../stores/auth';
import { errMsg } from '../api';

// 版式参考云补丁构建工具登录页：浅色页面 + 顶部品牌栏 + 左侧介绍 / 右侧登录卡片
const FEATURES = [
  {
    title: '多数据源统一管理',
    desc: '连接信息集中配置，权限按需分配',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
        <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
      </svg>
    ),
  },
  {
    title: '可视化 SQL 工作台',
    desc: '库表浏览、查询与结果一处完成',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m5 7 4 4-4 4" />
        <path d="M12 17h7" />
      </svg>
    ),
  },
  {
    title: 'AI 审计与高危拦截',
    desc: '高危 SQL 自动识别并二次确认',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3 4 7v5c0 4.7 3.2 7.8 8 9 4.8-1.2 8-4.3 8-9V7l-8-4Z" />
        <path d="m9 12 2 2 4-5" />
      </svg>
    ),
  },
  {
    title: '全量操作审计留痕',
    desc: '每一次查询都有据可查',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    ),
  },
];

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();
  const { message } = App.useApp();

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      await login(values.username, values.password);
      message.success('登录成功');
      navigate('/');
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <header className="login-header">
        <div className="login-header-inner">
          <div className="login-brand">
            <span className="login-brand-mark">
              <BrandLogo size={24} color="#fff" />
            </span>
            <span className="login-brand-text">
              <strong>DataX 数据库管理平台</strong>
              <small>DATABASE CONSOLE</small>
            </span>
          </div>
        </div>
      </header>

      <main className="login-main">
        <section className="login-intro">
          <p className="login-eyebrow">DATAX · 安全数据操作</p>
          <h1>
            让每一次数据操作
            <br />
            <span>更安全，也可追溯</span>
          </h1>
          <p className="login-desc">
            集成 AI 安全审计引擎，对高危 SQL 自动识别、预查询并二次确认；从连接数据源、执行查询到审计留痕，日常操作都在一处完成。
          </p>

          <div className="login-features">
            {FEATURES.map((item) => (
              <div className="login-feature" key={item.title}>
                <span className="login-feature-icon">{item.icon}</span>
                <span className="login-feature-text">
                  <strong>{item.title}</strong>
                  <small>{item.desc}</small>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="login-panel">
          <div className="login-card">
            <div className="login-card-head">
              <span className="login-card-badge">安全接入</span>
              <h2>账号登录</h2>
            </div>

            <Form
              onFinish={onFinish}
              size="large"
              layout="vertical"
              requiredMark={false}
              className="login-form"
            >
              <Form.Item
                label="用户名"
                name="username"
                rules={[{ required: true, message: '请输入用户名' }]}
              >
                <Input
                  prefix={<UserOutlined className="login-input-icon" />}
                  placeholder="请输入用户名"
                  autoFocus
                  autoComplete="username"
                />
              </Form.Item>
              <Form.Item
                label="密码"
                name="password"
                rules={[{ required: true, message: '请输入密码' }]}
              >
                <Input.Password
                  prefix={<LockOutlined className="login-input-icon" />}
                  placeholder="请输入密码"
                  autoComplete="current-password"
                />
              </Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                block
                loading={loading}
                className="login-submit"
              >
                登 录
              </Button>
            </Form>

            <p className="login-card-help">
              首次登录默认管理员账号，登录后请立即修改密码
            </p>
          </div>
        </section>
      </main>

      <footer className="login-footer">
        <span>DataX · B/S 数据库管理平台</span>
        <span>AI 审计 · 规则兜底 · 全量日志</span>
      </footer>
    </div>
  );
}
