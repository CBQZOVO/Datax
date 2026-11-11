import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  PlusOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api, errMsg, type Connection, type DataPermission, type User } from '../api';
import { fmtTime } from '../utils/time';
import { useAuthStore } from '../stores/auth';

interface PermissionGroup {
  connection: Connection;
  databases: string[];
}

export default function UserManagement() {
  const { message } = App.useApp();
  const currentUser = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<User[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<DataPermission[]>([]);
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [permissionLoading, setPermissionLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // 管理员的隐藏配置（勾选 = 在管理员侧隐藏该库/视图）
  const [hiddenItems, setHiddenItems] = useState<DataPermission[]>([]);
  const [dbFilter, setDbFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();

  const loadBase = async () => {
    setLoading(true);
    try {
      const [userRes, connectionRes] = await Promise.all([
        api.get('/auth/users'),
        api.get('/connections'),
      ]);
      setUsers(userRes.data.users);
      setConnections(connectionRes.data.connections);
    } catch (error) {
      message.error(errMsg(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (currentUser?.role === 'admin') void loadBase();
  }, [currentUser?.role]);

  // 当前选中用户的 id：快速切换用户时，慢响应回来后不再覆盖新选中的用户
  const selectedUserIdRef = useRef<number | null>(null);

  const selectUser = async (user: User) => {
    selectedUserIdRef.current = user.id;
    setSelectedUser(user);
    setPermissions([]);
    setHiddenItems([]);
    setGroups([]);
    setDbFilter('');
    setPermissionLoading(true);
    try {
      // 库列表用 all=1 取全量：管理员隐藏只影响展示，不应影响给普通用户授权、以及隐藏配置本身的勾选
      const [mainRes, ...databaseResponses] = await Promise.all([
        user.role === 'admin'
          ? api.get(`/auth/users/${user.id}/hidden-databases`)
          : api.get(`/auth/users/${user.id}/permissions`),
        ...connections.map((connection) =>
          api.get(`/metadata/${connection.id}/databases`, { params: { all: '1' } })),
      ]);
      if (selectedUserIdRef.current !== user.id) return;
      if (user.role === 'admin') {
        setHiddenItems(mainRes.data.hidden);
      } else {
        setPermissions(mainRes.data.permissions);
      }
      setGroups(connections.map((connection, index) => ({
        connection,
        databases: databaseResponses[index].data.databases,
      })));
    } catch (error) {
      if (selectedUserIdRef.current !== user.id) return;
      message.error(errMsg(error));
    } finally {
      if (selectedUserIdRef.current === user.id) setPermissionLoading(false);
    }
  };

  const selectedKeys = useMemo(
    () => new Set(permissions.map((item) => `${item.connectionId}\u0000${item.database}`)),
    [permissions]
  );

  const togglePermission = (connectionId: number, database: string, checked: boolean) => {
    setPermissions((items) => checked
      ? [...items, { userId: selectedUser!.id, connectionId, database }]
      : items.filter((item) => !(item.connectionId === connectionId && item.database === database)));
  };

  /** 全选/清空某个数据源下的全部数据库 */
  const setConnectionPermissions = (connectionId: number, databases: string[], checked: boolean) => {
    setPermissions((items) => {
      const rest = items.filter((item) => item.connectionId !== connectionId);
      if (!checked) return rest;
      return [...rest, ...databases.map((database) => ({ userId: selectedUser!.id, connectionId, database }))];
    });
  };

  const savePermissions = async () => {
    if (!selectedUser) return;
    setSaving(true);
    try {
      const { data } = await api.put(`/auth/users/${selectedUser.id}/permissions`, {
        permissions: permissions.map(({ connectionId, database }) => ({ connectionId, database })),
      });
      setPermissions(data.permissions);
      message.success('数据权限已保存');
    } catch (error) {
      message.error(errMsg(error));
    } finally {
      setSaving(false);
    }
  };

  const hiddenKeys = useMemo(
    () => new Set(hiddenItems.map((item) => `${item.connectionId}\u0000${item.database}`)),
    [hiddenItems]
  );

  const toggleHidden = (connectionId: number, database: string, checked: boolean) => {
    setHiddenItems((items) => checked
      ? [...items, { userId: selectedUser!.id, connectionId, database }]
      : items.filter((item) => !(item.connectionId === connectionId && item.database === database)));
  };

  /** 全选/清空某个数据源下的全部隐藏项 */
  const setConnectionHidden = (connectionId: number, databases: string[], checked: boolean) => {
    setHiddenItems((items) => {
      const rest = items.filter((item) => item.connectionId !== connectionId);
      if (!checked) return rest;
      return [...rest, ...databases.map((database) => ({ userId: selectedUser!.id, connectionId, database }))];
    });
  };

  const saveHidden = async () => {
    if (!selectedUser) return;
    setSaving(true);
    try {
      const { data } = await api.put(`/auth/users/${selectedUser.id}/hidden-databases`, {
        hidden: hiddenItems.map(({ connectionId, database }) => ({ connectionId, database })),
      });
      setHiddenItems(data.hidden);
      message.success('隐藏配置已保存');
    } catch (error) {
      message.error(errMsg(error));
    } finally {
      setSaving(false);
    }
  };

  const createUser = async () => {
    try {
      const values = await form.validateFields();
      setCreating(true);
      await api.post('/auth/users', values);
      message.success('账号创建成功，用户首次登录必须修改密码');
      setCreateOpen(false);
      form.resetFields();
      await loadBase();
    } catch (error) {
      if ((error as { errorFields?: unknown }).errorFields) return;
      message.error(errMsg(error));
    } finally {
      setCreating(false);
    }
  };

  if (currentUser?.role !== 'admin') return <Navigate to="/approvals" replace />;

  const isAdminTarget = selectedUser?.role === 'admin';

  const columns = [
    { title: '账号', dataIndex: 'username', render: (value: string) => <Space><UserOutlined />{value}</Space> },
    { title: '角色', dataIndex: 'role', width: 110, render: (value: User['role']) => <Tag color={value === 'admin' ? 'blue' : 'default'}>{value === 'admin' ? '管理员' : '普通用户'}</Tag> },
    { title: '创建时间', dataIndex: 'createdAt', width: 180, render: (value: string) => fmtTime(value) },
  ];

  return (
    <div className="management-page">
      <header className="management-header">
        <div className="management-title">
          <SafetyCertificateOutlined className="management-title-icon" />
          <div>
            <Typography.Title level={4}>用户与数据权限</Typography.Title>
            <Typography.Text type="secondary">创建登录账号，并按数据源、数据库分配最小访问权限</Typography.Text>
          </div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新增用户</Button>
      </header>

      <main className="management-content">
        <Row gutter={16} className="permission-layout">
          <Col xs={24} lg={10}>
            <Card title={`用户列表（${users.length}）`} className="management-card">
              <Table
                rowKey="id"
                loading={loading}
                columns={columns}
                dataSource={users}
                pagination={false}
                size="middle"
                rowClassName={(record) => record.id === selectedUser?.id ? 'management-row-selected' : ''}
                onRow={(record) => ({ onClick: () => void selectUser(record), style: { cursor: 'pointer' } })}
              />
            </Card>
          </Col>
          <Col xs={24} lg={14}>
            <Card
              title={selectedUser ? (isAdminTarget ? `${selectedUser.username} 的隐藏配置` : `${selectedUser.username} 的数据权限`) : '数据权限'}
              className="management-card"
              extra={selectedUser && (isAdminTarget
                ? <Button type="primary" loading={saving} onClick={() => void saveHidden()}>保存隐藏</Button>
                : selectedUser.role === 'user' && <Button type="primary" loading={saving} onClick={() => void savePermissions()}>保存权限</Button>)}
            >
              {!selectedUser ? (
                <Empty description="请先从左侧选择用户" />
              ) : permissionLoading ? (
                <div className="management-loading"><Spin /></div>
              ) : groups.length === 0 ? (
                <Empty description={isAdminTarget ? '暂无可配置的数据源' : '暂无可授权的数据源'} />
              ) : (
                <>
                  {isAdminTarget && (
                    <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
                      勾选需要隐藏的数据库/视图：仅影响管理员侧的树与列表显示，不影响普通用户授权与查询权限。
                    </Typography.Paragraph>
                  )}
                  <div className="perm-toolbar">
                    <Input
                      allowClear
                      prefix={<SearchOutlined className="login-input-icon" />}
                      placeholder="搜索数据库"
                      value={dbFilter}
                      onChange={(event) => setDbFilter(event.target.value)}
                    />
                    <Typography.Text type="secondary">
                      {isAdminTarget
                        ? `已隐藏 ${hiddenItems.length} 个数据库/视图`
                        : `共选中 ${permissions.length} 个数据库`}
                    </Typography.Text>
                  </div>

                  {groups.map(({ connection, databases }) => {
                    const keyOf = (database: string) => `${connection.id}\u0000${database}`;
                    const isChecked = (database: string) =>
                      isAdminTarget ? hiddenKeys.has(keyOf(database)) : selectedKeys.has(keyOf(database));
                    const checkedCount = databases.filter(isChecked).length;
                    const keyword = dbFilter.trim().toLowerCase();
                    const visible = keyword
                      ? databases.filter((database) => database.toLowerCase().includes(keyword))
                      : databases;
                    return (
                      <section className="perm-source" key={connection.id}>
                        <div className="perm-source-head">
                          <div className="perm-source-meta">
                            <Typography.Text strong>{connection.name}</Typography.Text>
                            <Tag color="blue">{connection.type.toUpperCase()}</Tag>
                            <Typography.Text type="secondary">{connection.host}:{connection.port}</Typography.Text>
                          </div>
                          <Space size={4}>
                            <Typography.Text type={checkedCount > 0 ? undefined : 'secondary'}>
                              {isAdminTarget ? `已隐藏` : '已选'} {checkedCount}/{databases.length}
                            </Typography.Text>
                            <Button
                              type="link"
                              size="small"
                              disabled={databases.length === 0}
                              onClick={() => (isAdminTarget ? setConnectionHidden : setConnectionPermissions)(connection.id, databases, true)}
                            >
                              全选
                            </Button>
                            <Button
                              type="link"
                              size="small"
                              disabled={checkedCount === 0}
                              onClick={() => (isAdminTarget ? setConnectionHidden : setConnectionPermissions)(connection.id, databases, false)}
                            >
                              清空
                            </Button>
                          </Space>
                        </div>

                        {databases.length === 0 ? (
                          <Typography.Text type="secondary">未发现数据库</Typography.Text>
                        ) : visible.length === 0 ? (
                          <Typography.Text type="secondary">无匹配数据库</Typography.Text>
                        ) : (
                          <div className="perm-db-grid">
                            {visible.map((database) => (
                              <Checkbox
                                key={database}
                                className="perm-db"
                                title={database}
                                checked={isChecked(database)}
                                onChange={(event) => (isAdminTarget ? toggleHidden : togglePermission)(connection.id, database, event.target.checked)}
                              >
                                {database}
                              </Checkbox>
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </>
              )}
            </Card>
          </Col>
        </Row>
      </main>

      <Modal title="新增用户" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => void createUser()} confirmLoading={creating} okText="创建账号">
        <Form form={form} layout="vertical" initialValues={{ role: 'user' }}>
          <Form.Item name="username" label="登录账号" rules={[{ required: true, min: 2, max: 64 }]}>
            <Input autoComplete="off" placeholder="请输入登录账号" />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 8, message: '密码至少 8 位' }]}>
            <Input.Password autoComplete="new-password" placeholder="首次登录后必须修改" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select options={[{ label: '普通用户', value: 'user' }, { label: '管理员', value: 'admin' }]} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
