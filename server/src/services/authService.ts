import bcrypt from 'bcryptjs';
import { createUser, findUserById, findUserByUsername, listUsers, updateUserPassword, verifyUserPassword } from '../db/store.js';
import { signToken } from '../middleware/auth.js';
import type { User } from '../types.js';

export class AuthService {
  login(username: string, password: string): { token: string; user: User } {
    const user = verifyUserPassword(username, password);
    if (!user) {
      throw new Error('用户名或密码错误');
    }
    return { token: signToken(user), user };
  }

  changePassword(userId: number, oldPassword: string, newPassword: string): void {
    const user = findUserById(userId);
    if (!user) throw new Error('用户不存在');
    const verified = verifyUserPassword(user.username, oldPassword);
    // 首次强制改密允许省略旧密码；普通改密仍必须校验旧密码
    if ((!user.mustChangePassword || oldPassword) && !verified) {
      throw new Error('原密码错误');
    }
    if (newPassword.length < 8) {
      throw new Error('新密码至少 8 位');
    }
    updateUserPassword(userId, bcrypt.hashSync(newPassword, 10));
  }

  adminCreateUser(username: string, password: string, role: 'admin' | 'user'): void {
    if (findUserByUsername(username)) {
      throw new Error('用户名已存在');
    }
    if (password.length < 8) {
      throw new Error('密码至少 8 位');
    }
    createUser(username, bcrypt.hashSync(password, 10), role);
  }

  listUsers(): User[] {
    return listUsers();
  }
}

export function authService(): AuthService {
  return new AuthService();
}
