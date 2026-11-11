import { useState } from 'react';
import { App, Form, Input, Modal } from 'antd';
import { errMsg } from '../api';
import { useAuthStore } from '../stores/auth';

export default function ChangePasswordModal({
  open,
  onClose,
  force,
}: {
  open: boolean;
  onClose: () => void;
  force?: boolean;
}) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const { message } = App.useApp();
  const changePassword = useAuthStore((s) => s.changePassword);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);
      await changePassword(values.oldPassword ?? '', values.newPassword);
      message.success('密码已修改');
      onClose();
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={force ? '首次登录，请修改初始密码' : '修改密码'}
      open={open}
      onCancel={force ? undefined : onClose}
      onOk={handleOk}
      okText="确认修改"
      cancelText={force ? undefined : '取消'}
      confirmLoading={loading}
      closable={!force}
      maskClosable={!force}
    >
      <Form form={form} layout="vertical">
        {!force && (
          <Form.Item name="oldPassword" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}>
            <Input.Password />
          </Form.Item>
        )}
        <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 8, message: '至少 8 位' }]}>
          <Input.Password />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="确认新密码"
          dependencies={['newPassword']}
          rules={[
            { required: true, message: '请再次输入' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                return Promise.reject(new Error('两次输入的密码不一致'));
              },
            }),
          ]}
        >
          <Input.Password />
        </Form.Item>
      </Form>
    </Modal>
  );
}
