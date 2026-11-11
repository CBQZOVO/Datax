import { createTheme } from '@uiw/codemirror-themes';
import { tags as t } from '@lezer/highlight';

/**
 * 自定义 SQL 主题（浅色）：白底融入工作台卡片，关键字用品牌蓝加粗，
 * 字符串/数字/注释用低饱和辅助色，贴合企业后台浅色风格。
 */
export const sqlLightTheme = createTheme({
  theme: 'light',
  settings: {
    background: '#ffffff',
    foreground: '#17243b',
    caret: '#275c9f',
    selection: 'rgba(39, 92, 159, 0.14)',
    selectionMatch: 'rgba(39, 92, 159, 0.08)',
    lineHighlight: 'rgba(39, 92, 159, 0.04)',
    gutterBackground: '#f6f9fd',
    gutterForeground: '#8a98aa',
  },
  styles: [
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: '#275c9f', fontWeight: 'bold' },
    { tag: t.operator, color: '#275c9f' },
    { tag: [t.string, t.special(t.string)], color: '#b3540c' },
    { tag: [t.number, t.bool, t.null], color: '#7c5cd6' },
    { tag: t.comment, color: '#8a98aa', fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#1a7f37' },
    { tag: [t.variableName, t.propertyName], color: '#17243b' },
    { tag: t.punctuation, color: '#5b6b7f' },
  ],
});
