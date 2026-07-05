/**
 * generateSongManifest.mjs
 *
 * 扫描 public/studio 下所有 .mp3 文件，
 * 生成 / 更新 public/studio/manifest.json。
 *
 * 运行: node scripts/generateSongManifest.mjs
 *
 * 行为：
 *   - 检测所有 .mp3 文件，为其生成条目
 *   - 如果 manifest.json 已存在，保留用户手动填写的 title、bpm、offset
 *   - 新文件自动添加，设置 title=文件名、bpm=120、offset=0
 *   - 已删除的 mp3 对应条目自动移除
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { extname, basename, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO_DIR = join(__dirname, '..', 'public', 'studio');
const MANIFEST_PATH = join(STUDIO_DIR, 'manifest.json');

/**
 * 生成稳定的歌曲 ID
 * - ASCII 文件名 → sanitize 后使用
 * - 纯中文 / 特殊字符 → djb2 hash 后备
 */
function makeId(name) {
  const ascii = name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (ascii.length >= 2) return ascii.toLowerCase();
  // djb2 hash
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0;
  }
  return 'song_' + (Math.abs(hash) % 100000).toString(36);
}

// 确保 studio 目录存在
if (!existsSync(STUDIO_DIR)) {
  console.log('[Songs] public/studio/ not found — creating empty directory.');
  process.exit(0);
}

// 扫描 .mp3 文件
const files = readdirSync(STUDIO_DIR)
  .filter(f => extname(f).toLowerCase() === '.mp3')
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  console.log('[Songs] No .mp3 files found in public/studio/ — writing empty manifest.');
  writeFileSync(MANIFEST_PATH, JSON.stringify([], null, 2), 'utf-8');
  console.log('[Songs] Empty manifest written to', MANIFEST_PATH);
  process.exit(0);
}

console.log(`[Songs] Found ${files.length} .mp3 file(s): ${files.join(', ')}`);

// 读取已有 manifest（如果存在）
/** @type {Array<{id:string, title:string, file:string, bpm:number, offset:number}>} */
let existing = [];
if (existsSync(MANIFEST_PATH)) {
  try {
    existing = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    if (!Array.isArray(existing)) existing = [];
    console.log(`[Songs] Existing manifest has ${existing.length} entry(s).`);
  } catch (e) {
    console.warn('[Songs] Failed to parse existing manifest — starting fresh.');
    existing = [];
  }
}

// 建立已有条目索引（按文件名）
const existingByFile = new Map();
for (const entry of existing) {
  existingByFile.set(entry.file, entry);
}

// 生成新 manifest
const manifest = [];
for (const filename of files) {
  const filePath = `/studio/${filename}`;
  const old = existingByFile.get(filePath);

  const nameWithoutExt = basename(filename, '.mp3');

  const entry = {
    id: makeId(nameWithoutExt),
    title: (old && old.title) ? old.title : nameWithoutExt,
    file: filePath,
    bpm: (old && typeof old.bpm === 'number') ? old.bpm : 120,
    offset: (old && typeof old.offset === 'number') ? old.offset : 0,
  };

  const action = old ? (old.id !== entry.id ? '[fix]' : '[keep]') : '[new]';
  if (action === '[fix]') {
    console.log(`  ${action} ${entry.title} — id: "${old.id}" → "${entry.id}"`);
  } else {
    console.log(`  ${action} ${entry.title} — bpm=${entry.bpm}, offset=${entry.offset}`);
  }

  manifest.push(entry);
}

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`[Songs] Manifest written: ${manifest.length} song(s) → ${MANIFEST_PATH}`);
