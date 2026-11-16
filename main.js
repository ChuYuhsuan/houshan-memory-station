'use strict';

const { app, BrowserWindow, protocol, shell, Menu, dialog, session, ipcMain, safeStorage, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const materials = require('./materials');

const IS_DEMO = process.argv.includes('--demo');
if (IS_DEMO) {
  const demoDir = path.join(app.getPath('appData'), '复习小助手3.1-演示模式');
  app.setPath('userData', demoDir);
  try {
    fs.mkdirSync(demoDir, { recursive: true });
    const realDir = path.join(app.getPath('appData'), '复习小助手3.1');
    const demoCfg = path.join(demoDir, 'ai-config.json');
    const realCfg = path.join(realDir, 'ai-config.json');
    if (!fs.existsSync(demoCfg) && fs.existsSync(realCfg)) fs.copyFileSync(realCfg, demoCfg);
    const realState = path.join(realDir, 'Local State');
    const demoState = path.join(demoDir, 'Local State');
    if (fs.existsSync(realState)) fs.copyFileSync(realState, demoState);
  } catch (_) {}
}

/* ---------- 从 3.0 / 2.x 迁移数据（IndexedDB、localStorage、资料） ---------- */
function migrateLegacyData() {
  try {
    const appData = app.getPath('appData');
    const target = app.getPath('userData');
    const legacyNames = ['复习小助手3.0', '西综艾宾浩斯复习小助手', '西综复习小助手'];
    if (legacyNames.some((n) => path.join(appData, n) === target)) return;
    for (const name of legacyNames) {
      const legacy = path.join(appData, name);
      if (!fs.existsSync(legacy)) continue;
      for (const sub of ['IndexedDB', 'Local Storage', 'materials']) {
        const from = path.join(legacy, sub);
        if (!fs.existsSync(from)) continue;
        const to = path.join(target, sub);
        if (fs.existsSync(to) && fs.readdirSync(to).length) continue;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
      }
      break;
    }
  } catch (_) {
    /* 迁移失败不影响启动 */
  }
}
if (!IS_DEMO) migrateLegacyData();

const APP_SCHEME = 'app';
const APP_HOST = 'local';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const ROOT = path.join(__dirname, 'app');
const START_URL = `${APP_ORIGIN}/index.html` + (IS_DEMO ? '?demo=1' : '');

// 只允许一个实例：再次双击 exe 时聚焦已有窗口，避免两个进程同时写同一份数据
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// 把 app:// 注册成标准 + 安全协议：IndexedDB / localStorage 因此拥有稳定 origin，
// 数据不会因为启动路径变化而丢失。
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false
    }
  },
  {
    scheme: 'mat',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

app.setAppUserModelId('com.yorkx.review31');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
};

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname || '/');
      if (rel === '/' || rel === '') rel = '/index.html';
      rel = rel.replace(/\\/g, '/');

      const target = path.normalize(path.join(ROOT, rel));
      // 目录穿越防护：只允许访问 app 目录内的文件
      if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }

      const data = await fs.promises.readFile(target);
      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      return new Response(data, {
        status: 200,
        headers: { 'content-type': type, 'cache-control': 'no-cache' }
      });
    } catch (_) {
      return new Response('Not Found', { status: 404 });
    }
  });
}

/* ---------------- AI 代理：请求走主进程，Key 不进入页面 ---------------- */
const AI_PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    note: '官方接口，稳定；deepseek-chat 适合出题，deepseek-reasoner 适合复杂推理。'
  },
  {
    id: 'moonshot',
    label: 'Kimi / 月之暗面',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'],
    note: 'OpenAI 兼容接口；可点“获取列表”读取账号可用模型。'
  },
  {
    id: 'dashscope',
    label: '通义千问 · 阿里云百炼',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    note: '百炼兼容模式；一个 Key 可调多个通义模型。'
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    note: 'OpenAI 兼容接口；模型名以账号权限为准。'
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    note: '聚合平台，建议点“获取列表”选择模型；模型名通常带命名空间。'
  },
  {
    id: 'volcengine',
    label: '火山方舟',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [],
    note: '模型字段通常填方舟“接入点 ID”（ep-...），以控制台为准。'
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    baseURL: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-Text-01', 'MiniMax-M1'],
    note: '使用 MiniMax 的 OpenAI 兼容接口；如果当前账号域名不同，可切“自定义”。'
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容',
    baseURL: '',
    models: [],
    custom: true,
    note: '任何兼容 /chat/completions 的接口；填写完整 baseURL 和模型名。'
  }
];
const AI_PROVIDER_MAP = Object.fromEntries(AI_PROVIDERS.map((p) => [p.id, p]));
const AI_DEFAULTS = { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' };
const aiControllers = new Map();
const aiConfigPath = () => path.join(app.getPath('userData'), 'ai-config.json');

function providerById(id) {
  return AI_PROVIDER_MAP[id] || AI_PROVIDER_MAP.custom;
}

function detectProviderId(baseURL) {
  const url = String(baseURL || '').toLowerCase();
  if (url.includes('api.deepseek.com')) return 'deepseek';
  if (url.includes('moonshot.cn')) return 'moonshot';
  if (url.includes('dashscope.aliyuncs.com')) return 'dashscope';
  if (url.includes('bigmodel.cn')) return 'zhipu';
  if (url.includes('siliconflow.cn')) return 'siliconflow';
  if (url.includes('volces.com')) return 'volcengine';
  if (url.includes('minimax')) return 'minimax';
  return 'custom';
}

function encryptKey(key) {
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(key).toString('base64');
  return Buffer.from(key, 'utf8').toString('base64');
}

function decryptKey(enc) {
  const buf = Buffer.from(enc, 'base64');
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch (_) {
    return '';
  }
}

function readRawAIConfig() {
  try {
    return JSON.parse(fs.readFileSync(aiConfigPath(), 'utf8'));
  } catch (_) {
    return {};
  }
}

function storedAIConfig() {
  const raw = readRawAIConfig();
  if (raw && raw.providers && typeof raw.providers === 'object' && raw.activeProvider) {
    return {
      activeProvider: AI_PROVIDER_MAP[raw.activeProvider] ? raw.activeProvider : 'custom',
      providers: raw.providers
    };
  }
  // 兼容 3.2.7 及以前的扁平配置：{ baseURL, model, keyEnc }
  const baseURL = typeof raw.baseURL === 'string' ? raw.baseURL : AI_DEFAULTS.baseURL;
  const model = typeof raw.model === 'string' ? raw.model : AI_DEFAULTS.model;
  const id = detectProviderId(baseURL);
  const providers = {};
  if (raw.baseURL || raw.model || raw.keyEnc) {
    providers[id] = { baseURL, model, ...(raw.keyEnc ? { keyEnc: raw.keyEnc } : {}) };
  }
  return { activeProvider: id, providers };
}

function readAIConfig() {
  const stored = storedAIConfig();
  const id = AI_PROVIDER_MAP[stored.activeProvider] ? stored.activeProvider : 'custom';
  const pd = providerById(id);
  const saved = stored.providers[id] || {};
  return {
    providerId: id,
    label: pd.label,
    custom: !!pd.custom,
    baseURL: saved.baseURL || pd.baseURL || AI_DEFAULTS.baseURL,
    model: saved.model || (pd.models && pd.models[0]) || AI_DEFAULTS.model,
    key: saved.keyEnc ? decryptKey(saved.keyEnc) : '',
    providers: stored.providers
  };
}

function publicAIConfig(cfg) {
  const providers = {};
  AI_PROVIDERS.forEach((pd) => {
    const saved = (cfg.providers && cfg.providers[pd.id]) || {};
    providers[pd.id] = {
      baseURL: saved.baseURL || pd.baseURL || '',
      model: saved.model || (pd.models && pd.models[0]) || '',
      hasKey: !!saved.keyEnc
    };
  });
  Object.keys(cfg.providers || {}).forEach((id) => {
    if (!providers[id]) {
      const saved = cfg.providers[id] || {};
      providers[id] = { baseURL: saved.baseURL || '', model: saved.model || '', hasKey: !!saved.keyEnc };
    }
  });
  return {
    providerId: cfg.providerId,
    providerLabel: cfg.label,
    custom: !!cfg.custom,
    baseURL: cfg.baseURL,
    model: cfg.model,
    hasKey: !!cfg.key,
    keyMask: cfg.key ? cfg.key.slice(0, 4) + '…' + cfg.key.slice(-4) : '',
    providers
  };
}

function writeAIConfig(next) {
  const stored = storedAIConfig();
  const id = AI_PROVIDER_MAP[next.providerId] ? next.providerId : (stored.activeProvider || 'deepseek');
  const pd = providerById(id);
  const cur = stored.providers[id] || {};
  const baseURL = String(next.baseURL || cur.baseURL || (pd.custom ? '' : pd.baseURL) || '').trim().replace(/\/+$/, '');
  const model = String(next.model || cur.model || (pd.models && pd.models[0]) || '').trim();
  if (!/^https?:\/\//i.test(baseURL)) throw new Error('接口地址需以 http:// 或 https:// 开头');
  if (!model) throw new Error('请填写模型名称');

  const entry = { baseURL, model };
  if (next.clearKey) {
    // 仅清除当前平台的 Key
  } else if (typeof next.key === 'string' && next.key.trim()) {
    entry.keyEnc = encryptKey(next.key.trim());
  } else if (cur.keyEnc) {
    entry.keyEnc = cur.keyEnc;
  }
  stored.providers[id] = entry;
  stored.activeProvider = id;
  fs.mkdirSync(path.dirname(aiConfigPath()), { recursive: true });
  fs.writeFileSync(aiConfigPath(), JSON.stringify(stored, null, 2), 'utf8');
  return readAIConfig();
}

function chatEndpoint(baseURL) {
  return String(baseURL).replace(/\/+$/, '') + '/chat/completions';
}

function parseApiError(status, text) {
  let detail = text;
  try {
    const json = JSON.parse(text);
    detail = (json.error && json.error.message) || text;
  } catch (_) {}
  return `接口返回 ${status}${detail ? '：' + String(detail).slice(0, 220) : ''}`;
}

async function testAIConnection() {
  const cfg = readAIConfig();
  if (!cfg.key) return { ok: false, message: '尚未配置 API Key' };
  try {
    const res = await net.fetch(chatEndpoint(cfg.baseURL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: '回复两个字：可用' }],
        max_tokens: 16,
        temperature: 0
      }),
      signal: AbortSignal.timeout(30000)
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, message: parseApiError(res.status, text) };
    let model = cfg.model;
    try {
      const json = JSON.parse(text);
      model = json.model || cfg.model;
    } catch (_) {}
    return { ok: true, model };
  } catch (err) {
    return { ok: false, message: err && err.name === 'AbortError' ? '连接超时，请检查网络后重试' : (err && err.message ? err.message : String(err)) };
  }
}

function publicProviders() {
  return AI_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    baseURL: p.baseURL || '',
    models: Array.isArray(p.models) ? p.models.slice() : [],
    custom: !!p.custom,
    note: p.note || ''
  }));
}

async function listProviderModels(baseURL, key) {
  if (!key) return { ok: false, message: '请先填写 API Key' };
  const url = String(baseURL || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: '接口地址不正确' };
  try {
    const res = await net.fetch(url + '/models', {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, message: parseApiError(res.status, text) };
    let json;
    try { json = JSON.parse(text); } catch (_) { return { ok: false, message: '平台没有返回 JSON 模型列表' }; }
    const arr = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []);
    const models = [...new Set(arr.map((x) => typeof x === 'string' ? x : (x && (x.id || x.name))).filter(Boolean))].sort();
    return models.length ? { ok: true, models } : { ok: false, message: '没有读到模型列表，可手动填写模型名' };
  } catch (err) {
    return { ok: false, message: err && err.name === 'AbortError' ? '获取模型列表超时' : (err && err.message ? err.message : String(err)) };
  }
}

function registerAI() {
  ipcMain.handle('ai:get-config', () => publicAIConfig(readAIConfig()));

  ipcMain.handle('ai:get-providers', () => publicProviders());

  ipcMain.handle('ai:list-models', async (_event, payload) => {
    const cfg = readAIConfig();
    const baseURL = String((payload && payload.baseURL) || cfg.baseURL || '').trim();
    const key = String((payload && payload.key) || cfg.key || '').trim();
    return listProviderModels(baseURL, key);
  });

  ipcMain.handle('ai:save-config', (_event, next) => publicAIConfig(writeAIConfig(next || {})));

  ipcMain.handle('ai:clear-key', () => {
    const cur = readAIConfig();
    writeAIConfig({ baseURL: cur.baseURL, model: cur.model, clearKey: true });
    return publicAIConfig(readAIConfig());
  });

  ipcMain.handle('ai:test', () => testAIConnection());

  ipcMain.on('ai:abort', (_event, id) => {
    const controller = aiControllers.get(String(id));
    if (controller) controller.abort();
  });

  ipcMain.handle('ai:chat', async (event, payload) => {
    const cfg = readAIConfig();
    if (!cfg.key) throw new Error('尚未配置 API Key，请到「复习设置 → AI 服务」填写');
    const messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
    if (!messages.length) throw new Error('请求内容为空');
    const totalChars = messages.reduce((n, m) => n + String((m && m.content) || '').length, 0);
    if (totalChars > 20000) throw new Error('请求内容过长');

    const id = String((payload && payload.id) || Date.now());
    const wantJson = !!(payload && payload.json);
    const controller = new AbortController();
    aiControllers.set(id, controller);
    const timer = setTimeout(() => controller.abort(), wantJson ? 150000 : 90000);
    try {
      const body = {
        model: cfg.model,
        messages: messages.map((m) => ({ role: String(m.role || 'user'), content: String(m.content || '') })),
        temperature: Number.isFinite(payload.temperature) ? payload.temperature : 0.5,
        max_tokens: Math.min(8000, Number(payload.maxTokens) || 800),
        stream: !wantJson
      };
      if (wantJson) body.response_format = { type: 'json_object' };

      const doRequest = (payloadBody) => net.fetch(chatEndpoint(cfg.baseURL), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify(payloadBody),
        signal: controller.signal
      });

      let res = await doRequest(body);
      // 有些平台不支持 response_format；去掉 JSON 模式再试一次，避免直接失败。
      if (!res.ok && wantJson && (res.status === 400 || res.status === 422)) {
        try { await res.text(); } catch (_) {}
        const retryBody = { ...body };
        delete retryBody.response_format;
        res = await doRequest(retryBody);
      }

      if (!res.ok) {
        let text = '';
        try {
          text = await res.text();
        } catch (_) {}
        throw new Error(parseApiError(res.status, text));
      }

      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      if (wantJson) {
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch (_) {
          throw new Error('接口返回的不是合法 JSON，请检查模型是否支持 JSON 输出');
        }
        const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
        if (!content) throw new Error('接口没有返回内容');
        return content;
      }

      // 少数平台即使 stream=true 也返回普通 JSON；直接取 message.content。
      if (contentType.includes('application/json')) {
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch (_) { throw new Error('接口返回格式无法识别'); }
        const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
        if (!content) throw new Error('接口没有返回内容');
        return content;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
            if (delta) {
              full += delta;
              event.sender.send('ai:chunk', { id, delta });
            }
          } catch (_) {
            /* 单行解析失败忽略 */
          }
        }
      }
      return full;
    } finally {
      clearTimeout(timer);
      aiControllers.delete(id);
    }
  });
}

// ---------------- 窗口位置 / 大小记忆 ----------------
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function readWindowState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    const s = JSON.parse(raw);
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) {
      return {
        width: Math.max(420, Math.round(s.width)),
        height: Math.max(560, Math.round(s.height)),
        x: Number.isFinite(s.x) ? Math.round(s.x) : undefined,
        y: Number.isFinite(s.y) ? Math.round(s.y) : undefined,
        maximized: !!s.maximized
      };
    }
  } catch (_) {
    /* 首次启动没有状态文件，用默认尺寸 */
  }
  return { width: 1120, height: 820, maximized: false };
}

function isOnScreen(bounds) {
  try {
    const { screen } = require('electron');
    return screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return (
        bounds.x < wa.x + wa.width &&
        bounds.x + bounds.width > wa.x &&
        bounds.y < wa.y + wa.height &&
        bounds.y + bounds.height > wa.y
      );
    });
  } catch (_) {
    return true;
  }
}

let mainWindow = null;
let saveStateTimer = null;

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const b = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: mainWindow.isMaximized() }), 'utf8');
  } catch (_) {
    /* 写状态失败不影响使用 */
  }
}

function scheduleSaveWindowState() {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(saveWindowState, 400);
}

function createWindow() {
  const saved = readWindowState();
  const { screen } = require('electron');
  // 保证窗口完整落在当前屏幕工作区内（小屏 / 125% 缩放的笔记本也不会露出屏幕外）
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(saved.width, Math.max(420, workArea.width - 40));
  const height = Math.min(saved.height, Math.max(560, workArea.height - 40));
  const hasSavedPos = Number.isFinite(saved.x) && Number.isFinite(saved.y) && isOnScreen(saved);

  mainWindow = new BrowserWindow({
    width,
    height,
    ...(hasSavedPos ? { x: saved.x, y: saved.y } : { center: true }),
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: IS_DEMO ? '复习小助手1.12.1（演示模式）' : '复习小助手1.12.1',
    backgroundColor: '#eef7f1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      backgroundThrottling: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);

  if (saved.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // 外部链接交给系统浏览器，应用内不允许跳走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details && details.reason !== 'clean-exit') {
      dialog.showErrorBox('页面异常', '界面进程已退出，请重新打开本程序。');
    }
  });

  // F5 / Ctrl+R 刷新，F12 开发者工具（出问题时可自行排查）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const ctrl = input.control || input.meta;
    if (key === 'f5' || (ctrl && key === 'r')) {
      mainWindow.webContents.reload();
      event.preventDefault();
    } else if (key === 'f12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('move', scheduleSaveWindowState);
  mainWindow.on('maximize', scheduleSaveWindowState);
  mainWindow.on('unmaximize', scheduleSaveWindowState);
  mainWindow.on('close', saveWindowState);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(START_URL);
}

// 保存可编辑试卷 / 文本（Word .doc 由 HTML 生成，可在 Word 中继续修改）
ipcMain.handle('app:relaunch-mode', (_event, demo) => {
  const args = process.argv.slice(1).filter((a) => a !== '--demo');
  if (demo) args.push('--demo');
  app.relaunch({ args });
  app.exit(0);
  return true;
});

ipcMain.handle('file:save-text', async (event, payload) => {
  const data = payload || {};
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const suggested = String(data.defaultName || '试卷.doc').replace(/[\\/:*?"<>|]/g, '_');
  const result = await dialog.showSaveDialog(owner || undefined, {
    title: '保存试卷',
    buttonLabel: '保存',
    defaultPath: path.join(app.getPath('documents'), suggested),
    filters: Array.isArray(data.filters) && data.filters.length ? data.filters : [
      { name: 'Word 文档', extensions: ['doc'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.promises.writeFile(result.filePath, String(data.content || ''), 'utf8');
  return { canceled: false, filePath: result.filePath };
});

// 直接生成 A4 标准 PDF：由用户选择保存路径，不经过浏览器打印对话框
ipcMain.handle('file:save-pdf', async (event, payload) => {
  const data = payload || {};
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const suggested = String(data.defaultName || '试卷.pdf').replace(/[\\/:*?"<>|]/g, '_');
  const result = await dialog.showSaveDialog(owner || undefined, {
    title: '导出 PDF 试卷',
    buttonLabel: '导出',
    defaultPath: path.join(app.getPath('documents'), suggested),
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const targetPath = result.filePath;
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { sandbox: true, contextIsolation: true }
  });
  try {
    const html = String(data.html || '');
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;text-align:center;font-family:SimSun,serif;font-size:7.5pt;color:#444;padding-top:0">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>'
    });
    await fs.promises.writeFile(targetPath, pdf);
    return { canceled: false, filePath: targetPath };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});

// 导出 JSON 时弹出"另存为"，而不是默默丢进下载文件夹
function setupDownloads() {
  session.defaultSession.on('will-download', (event, item, webContents) => {
    const suggested = item.getFilename() || '复习计划.json';
    const owner = webContents ? BrowserWindow.fromWebContents(webContents) : mainWindow;

    item.pause();
    dialog
      .showSaveDialog(owner || undefined, {
        title: '导出数据',
        buttonLabel: '保存',
        defaultPath: path.join(app.getPath('documents'), suggested),
        filters: [
          { name: 'JSON 数据', extensions: ['json'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      .then(({ canceled, filePath }) => {
        if (canceled || !filePath) {
          item.cancel();
          return;
        }
        item.setSavePath(filePath);
        item.resume();
      })
      .catch(() => item.cancel());
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  // 界面是浅色主题，标题栏/原生对话框也统一成浅色
  try {
    require('electron').nativeTheme.themeSource = 'light';
  } catch (_) {}

  registerAppProtocol();
  protocol.handle('mat', (request) => materials.serve(request));
  materials.init(path.join(app.getPath('userData'), 'materials'), {
    ipcMain,
    dialog,
    shell,
    getWindow: (event) => BrowserWindow.fromWebContents(event.sender) || mainWindow
  });
  setupDownloads();
  registerAI();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  saveWindowState();
  app.quit();
});
