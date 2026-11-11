import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import './index.css';

dayjs.locale('zh-cn');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          // 品牌蓝与状态色：与 docs/visual-style-guide.md 对齐
          colorPrimary: '#275c9f',
          colorInfo: '#275c9f',
          colorSuccess: '#67c23a',
          colorWarning: '#e6a23c',
          colorError: '#f56c6c',
          // 中性偏冷灰蓝文本与页面底色
          colorTextBase: '#17243b',
          colorBgLayout: '#f3f6fb',
          colorBorderSecondary: '#eef2f7',
          // 整体放大一号：字号 15、控件高 36，视觉更大气
          fontSize: 15,
          controlHeight: 36,
          // 圆角：按钮/输入 8px，卡片/弹窗 14px
          borderRadius: 8,
          borderRadiusLG: 14,
          // 系统字体栈
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif",
        },
        cssVar: true,
      }}
    >
      <AntApp>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>
);
