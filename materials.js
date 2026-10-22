'use strict';

/**
 * 资料库：知识点附件 + 历年真题
 * - 文件保存在 userData/materials/<itemId>/（真题用 _exam 目录）
 * - PDF 提取文字层，图片用 Windows 自带 OCR，TXT/MD 直接读取
 * - 提取结果写成同名 .txt，渲染层按需读取
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_FILES_PER_ITEM = 30;
const ALLOWED = {
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.gif': 'image',
  '.txt': 'text',
  '.md': 'text'
};
const MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

let ROOT = '';

/* ---------- OCR：调用 Windows.Media.Ocr ---------- */
const PS_OCR = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]',
  '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]',
  '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]',
  '$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]',
  "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  'function Await($op, $type) {',
  '  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))',
  '  $task.Wait(-1) | Out-Null',
  '  $task.Result',
  '}',
  '$path = $env:OCR_PATH',
  '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])',
  '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  "$lang = New-Object Windows.Globalization.Language 'zh-Hans-CN'",
  '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)',
  'if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }',
  "if (-not $engine) { throw 'OCR engine unavailable' }",
  '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  '$out = $env:OCR_OUT',
  '[IO.File]::WriteAllText($out, $result.Text, (New-Object System.Text.UTF8Encoding($false)))',
  "Write-Output 'OK'"
].join('\n');

function ocrImage(file) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), 'xz-ocr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.txt');
    const encoded = Buffer.from(PS_OCR, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: { ...process.env, OCR_PATH: file, OCR_OUT: outFile },
        windowsHide: true,
        timeout: 90000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8'
      },
      (err, _stdout, stderr) => {
        if (err) {
          try { fs.unlinkSync(outFile); } catch (_) {}
          reject(new Error(String(stderr || err.message || 'OCR 失败').slice(0, 300)));
          return;
        }
        try {
          const text = fs.readFileSync(outFile, 'utf8');
          fs.unlinkSync(outFile);
          resolve(text);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

/* ---------- PDF ---------- */
async function extractPdf(file) {
  // 提前补上 pdf.js 在 Node 下调用的渲染占位，避免它去 require('canvas')
  if (typeof globalThis.DOMMatrix === 'undefined') globalThis.DOMMatrix = class DOMMatrix {};
  if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = class Path2D {};
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(await fs.promises.readFile(file));
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const parts = [];
  const pages = Math.min(doc.numPages, 200);
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      line += item.str;
      if (item.hasEOL) line += '\n';
    }
    parts.push(`【第${i}页】\n${line.trim()}`);
    if (typeof page.cleanup === 'function') page.cleanup();
  }
  await doc.destroy();
  return parts.join('\n\n');
}

/* ---------- 工具 ---------- */
function cleanText(input) {
  return String(input || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u4e00-\u9fa5][ \t]+(?=[\u4e00-\u9fa5])/g, (m) => m[0])
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\uFEFF/, '')
    .trim();
}

function scopeKey(scope, itemId) {
  if (scope === 'exam') return '_exam';
  if (!ID_RE.test(String(itemId || ''))) throw new Error('知识点 ID 非法');
  return String(itemId);
}

function scopeDir(scope, itemId) {
  const dir = path.join(ROOT, scopeKey(scope, itemId));
  const normalized = path.normalize(dir);
  if (!normalized.startsWith(ROOT)) throw new Error('路径非法');
  return normalized;
}

function safeName(name) {
  return String(name || '资料').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '资料';
}

async function findStored(dir, id) {
  const files = await fs.promises.readdir(dir);
  return files.find((f) => f.startsWith(id + '.') && !f.endsWith('.txt')) ||
    files.find((f) => f === id + '.txt') || null;
}

/* ---------- 初始化 ---------- */
function init(root, deps) {
  ROOT = path.normalize(root);
  fs.mkdirSync(ROOT, { recursive: true });
  const { ipcMain, dialog, shell } = deps;

  ipcMain.handle('materials:pick', async (event) => {
    const win = deps.getWindow(event);
    const res = await dialog.showOpenDialog(win, {
      title: '选择资料',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '资料（PDF / 图片 / 文本）', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'txt', 'md'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('materials:add', async (_event, payload) => {
    const { scope, itemId, filePath } = payload || {};
    const ext = path.extname(String(filePath || '')).toLowerCase();
    const kind = ALLOWED[ext];
    if (!kind) throw new Error('不支持该文件类型');
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error('不是文件');
    if (stat.size > MAX_FILE_SIZE) throw new Error('单个文件不能超过 50MB');

    const dir = scopeDir(scope, itemId);
    await fs.promises.mkdir(dir, { recursive: true });
    const existing = (await fs.promises.readdir(dir)).filter((f) => !f.endsWith('.txt'));
    if (existing.length >= MAX_FILES_PER_ITEM) throw new Error(`每条知识点最多 ${MAX_FILES_PER_ITEM} 份资料`);

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const stored = id + ext;
    await fs.promises.copyFile(filePath, path.join(dir, stored));

    let text = '';
    let ocr = false;
    let error = '';
    try {
      if (kind === 'pdf') {
        text = await extractPdf(path.join(dir, stored));
        if (text.replace(/\s/g, '').length < 20) {
          error = '这个 PDF 没有可提取的文字层（可能是扫描件），建议上传截图或手动补充文字';
        }
      } else if (kind === 'image') {
        text = await ocrImage(path.join(dir, stored));
        ocr = true;
        if (!text.trim()) error = '图片没有识别出文字，可手动补充';
      } else {
        text = await fs.promises.readFile(path.join(dir, stored), 'utf8');
      }
    } catch (e) {
      error = '解析失败：' + String(e.message || e).slice(0, 160);
    }

    text = cleanText(text);
    await fs.promises.writeFile(path.join(dir, id + '.txt'), text, 'utf8');

    return {
      id,
      name: safeName(path.basename(String(filePath))),
      kind,
      file: stored,
      size: stat.size,
      chars: text.length,
      ocr,
      error,
      addedAt: Date.now()
    };
  });

  ipcMain.handle('materials:add-text', async (_event, payload) => {
    const { scope, itemId, name, text } = payload || {};
    const value = cleanText(text);
    if (!value.trim()) throw new Error('资料内容为空');

    const dir = scopeDir(scope, itemId);
    await fs.promises.mkdir(dir, { recursive: true });
    const existing = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.txt'));
    if (existing.length >= MAX_FILES_PER_ITEM) throw new Error(`每条知识点最多 ${MAX_FILES_PER_ITEM} 份资料`);

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const stored = id + '.txt';
    await fs.promises.writeFile(path.join(dir, stored), value, 'utf8');

    return {
      id,
      name: safeName(name || '演示资料.txt'),
      kind: 'text',
      file: stored,
      size: Buffer.byteLength(value, 'utf8'),
      chars: value.length,
      ocr: false,
      error: '',
      addedAt: Date.now()
    };
  });

  ipcMain.handle('materials:remove', async (_event, payload) => {
    const { scope, itemId, id } = payload || {};
    if (!ID_RE.test(String(id || ''))) throw new Error('资料 ID 非法');
    const dir = scopeDir(scope, itemId);
    const files = await fs.promises.readdir(dir).catch(() => []);
    await Promise.all(
      files
        .filter((f) => f.startsWith(id + '.'))
        .map((f) => fs.promises.unlink(path.join(dir, f)).catch(() => {}))
    );
    return true;
  });

  ipcMain.handle('materials:text', async (_event, payload) => {
    const { scope, itemId, list } = payload || {};
    const dir = scopeDir(scope, itemId);
    const chunks = [];
    const missing = [];
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || !ID_RE.test(String(entry.id || ''))) continue;
      try {
        const text = await fs.promises.readFile(path.join(dir, entry.id + '.txt'), 'utf8');
        if (text.trim()) chunks.push(`【资料：${entry.name || '未命名'}】\n${text.trim()}`);
      } catch (_) {
        missing.push(entry.id);
      }
    }
    return { text: chunks.join('\n\n'), missing };
  });

  ipcMain.handle('materials:read-text', async (_event, payload) => {
    const { scope, itemId, id } = payload || {};
    if (!ID_RE.test(String(id || ''))) throw new Error('资料 ID 非法');
    const dir = scopeDir(scope, itemId);
    try {
      return await fs.promises.readFile(path.join(dir, id + '.txt'), 'utf8');
    } catch (_) {
      return '';
    }
  });

  ipcMain.handle('materials:write-text', async (_event, payload) => {
    const { scope, itemId, id, text } = payload || {};
    if (!ID_RE.test(String(id || ''))) throw new Error('资料 ID 非法');
    const dir = scopeDir(scope, itemId);
    const value = cleanText(text);
    await fs.promises.writeFile(path.join(dir, id + '.txt'), value, 'utf8');
    return value.length;
  });

  ipcMain.handle('materials:open', async (_event, payload) => {
    const { scope, itemId, id } = payload || {};
    if (!ID_RE.test(String(id || ''))) throw new Error('资料 ID 非法');
    const dir = scopeDir(scope, itemId);
    const file = await findStored(dir, id);
    if (!file) throw new Error('文件不存在');
    const err = await shell.openPath(path.join(dir, file));
    return err || '';
  });

  ipcMain.handle('materials:purge', async (_event, payload) => {
    const { itemId } = payload || {};
    if (!ID_RE.test(String(itemId || ''))) return false;
    const dir = scopeDir('item', itemId);
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    return true;
  });
}

/* ---------- mat:// 协议 ---------- */
async function serve(request) {
  try {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname || '/').replace(/^\/+/, '');
    const target = path.normalize(path.join(ROOT, rel));
    if (!target.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    const data = await fs.promises.readFile(target);
    const ext = path.extname(target).toLowerCase();
    return new Response(data, { headers: { 'content-type': MIME[ext] || 'application/octet-stream' } });
  } catch (_) {
    return new Response('Not Found', { status: 404 });
  }
}

module.exports = { init, serve };
