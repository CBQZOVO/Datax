import { create } from 'zustand';
import { api, type User } from '../api';

interface AuthState {
  user: User | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  fetchMe: () => Promise<void>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: localStorage.getItem('datax_token'),

  async login(username, password) {
    const { data } = await api.post('/auth/login', { username, password });
    localStorage.setItem('datax_token', data.token);
    set({ user: data.user, token: data.token });
  },

  logout() {
    localStorage.removeItem('datax_token');
    set({ user: null, token: null });
  },

  async fetchMe() {
    const { data } = await api.get('/auth/me');
    set({ user: data.user });
  },

  async changePassword(oldPassword, newPassword) {
    await api.post('/auth/change-password', { oldPassword, newPassword });
    // 后端改密时递增 token_version 吊销旧 JWT，前端主动登出，强制重新登录
    get().logout();
  },
}));
