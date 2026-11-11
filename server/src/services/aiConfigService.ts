import { loadConfig } from '../config.js';
import { decryptSecret, encryptSecret, getSetting, setSetting } from '../db/store.js';

/**
 * AI 配置管理：env 是初始默认值，系统管理界面保存的配置存 SQLite 并覆盖 env；
 * 保存后直接改内存中的缓存配置，立即生效，无需重启。
 * API Key 与数据源密码同款 AES-256-GCM 加密存储；读取时兼容旧的明文值。
 */

const MASK = (v: string) => (v.length > 8 ? `${v.slice(0, 4)}****${v.slice(-4)}` : '****');

/** 读 API Key：新数据是密文，旧数据（升级前写入的明文）解密失败时原样返回 */
function readApiKeySetting(): string | null {
  const raw = getSetting('ai.apiKey');
  if (raw === null || raw === '') return raw;
  try {
    return decryptSecret(raw);
  } catch {
    // SECRET_KEY 被更换后旧密文解不开：静默回落会让 AI 报 401 难排查，至少留一条日志
    console.warn('ai.apiKey 解密失败（SECRET_KEY 可能已更换），按明文回读——请到「系统管理 → AI 配置」重新保存 API Key');
    return raw;
  }
}

/** 启动时及保存后调用：用 SQLite 持久化的配置覆盖内存配置 */
export function applyPersistedAiConfig(): void {
  const ai = loadConfig().ai;
  const baseURL = getSetting('ai.baseURL');
  if (baseURL !== null) ai.baseURL = baseURL;
  const apiKey = readApiKeySetting();
  if (apiKey !== null) ai.apiKey = apiKey;
  const model = getSetting('ai.model');
  if (model !== null && model !== '') ai.model = model;
  const mode = getSetting('ai.auditMode');
  if (mode === 'strict' || mode === 'warn' || mode === 'off') ai.auditMode = mode;
  const timeout = getSetting('ai.timeoutMs');
  const timeoutNum = Number(timeout);
  if (timeout !== null && Number.isFinite(timeoutNum) && timeoutNum >= 1000) ai.timeoutMs = timeoutNum;
}

export interface AiConfigView {
  baseURL: string;
  model: string;
  auditMode: 'strict' | 'warn' | 'off';
  timeoutMs: number;
  hasApiKey: boolean;
  apiKeyMasked: string;
}

export function getAiConfigView(): AiConfigView {
  const ai = loadConfig().ai;
  return {
    baseURL: ai.baseURL,
    model: ai.model,
    auditMode: ai.auditMode,
    timeoutMs: ai.timeoutMs,
    hasApiKey: Boolean(ai.apiKey),
    apiKeyMasked: ai.apiKey ? MASK(ai.apiKey) : '',
  };
}

export interface AiConfigInput {
  baseURL: string;
  model: string;
  auditMode: 'strict' | 'warn' | 'off';
  /** undefined = 保持现有 Key 不变；空串 = 清除（关闭 AI） */
  apiKey?: string;
  timeoutMs?: number;
}

export function saveAiConfig(input: AiConfigInput): AiConfigView {
  setSetting('ai.baseURL', input.baseURL.trim().replace(/\/$/, ''));
  setSetting('ai.model', input.model.trim());
  setSetting('ai.auditMode', input.auditMode);
  if (input.timeoutMs != null) setSetting('ai.timeoutMs', String(input.timeoutMs));
  if (input.apiKey !== undefined) {
    const key = input.apiKey.trim();
    // 空串 = 清除（关闭 AI）；非空走 AES-256-GCM 加密存储
    setSetting('ai.apiKey', key === '' ? '' : encryptSecret(key));
  }
  applyPersistedAiConfig();
  return getAiConfigView();
}

/** 用当前配置发一次最小化对话请求，验证连通性 */
export async function testAiConfig(): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const ai = loadConfig().ai;
  if (!ai.apiKey || !ai.baseURL) {
    return { ok: false, message: '尚未配置服务地址或 API Key', latencyMs: 0 };
  }
  const urls = [`${ai.baseURL}/chat/completions`];
  if (!/\/v1$/.test(ai.baseURL)) urls.push(`${ai.baseURL}/v1/chat/completions`);
  const start = Date.now();
  let lastError = '';
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(ai.timeoutMs, 10000));
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ai.apiKey}`,
        },
        body: JSON.stringify({
          model: ai.model,
          messages: [{ role: 'user', content: '请只回复：ok' }],
          temperature: 0,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        // 透出网关的错误信息，便于定位（401 Key 错 / 404 路径错 / 400 模型名错等）
        const body = await resp.text().catch(() => '');
        lastError = `HTTP ${resp.status}: ${body.slice(0, 160)}`;
        continue;
      }
      const data = (await resp.json()) as {
        choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
      };
      const choice = data.choices?.[0];
      if (!choice) {
        lastError = '响应中没有 choices 字段';
        continue;
      }
      // 推理模型可能只有 reasoning_content（content 为 null），同样算连通
      const text = (choice.message?.content ?? choice.message?.reasoning_content ?? '').trim();
      return {
        ok: true,
        message: `连接成功，模型 ${ai.model} 已响应（${text.slice(0, 24) || '无文本输出'}）`,
        latencyMs: Date.now() - start,
      };
    } catch (e) {
      lastError = e instanceof Error ? (e.name === 'AbortError' ? '请求超时' : e.message) : String(e);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, message: `连接失败：${lastError || '无法通过当前配置调用模型'}`, latencyMs: Date.now() - start };
}
