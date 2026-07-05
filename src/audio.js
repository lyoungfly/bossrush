/**
 * audio.js — 音乐播放 & 节拍时间模块
 *
 * 基于 Web Audio API (AudioContext + AudioBufferSourceNode) 实现。
 *
 * 用法：
 *   import { loadMusic, startMusic, getSongTime, isPlaying } from './audio.js';
 *   await loadMusic('/audio/song.mp3');
 *   startMusic(0);
 *
 * 导出：
 *   loadMusic(url)           — 加载并解码音频文件
 *   startMusic(offset?)      — 从指定偏移开始播放
 *   stop()                   — 停止播放
 *   getSongTime()            — 当前播放时间 (秒)
 *   isPlaying()              — 是否正在播放
 *   setBPM(bpm)              — 设置 BPM（供 scoring.js 节拍判定用）
 *   getNearestBeat()         — 获取最近的节拍信息
 */

// ═══════════════════════════════════════════════════
// 音频核心状态
// ═══════════════════════════════════════════════════

let audioContext = null;
let audioBuffer = null;
let sourceNode = null;

let startTime = 0;    // AudioContext.currentTime 播放开始时刻
let startOffset = 0;  // 开始播放时的偏移量 (秒)
let playing = false;
let duration = 0;
let musicGainNode = null; // 音乐音量控制

// 回退时钟：音乐不可用时用 performance.now() 驱动
let fallbackStart = 0;
let fallbackPauseOffset = 0;  // 暂停期间累计的偏移
let fallbackPausedAt = 0;     // 暂停时刻

/**
 * 启动回退时钟（音乐加载失败时调用）
 */
export function startFallbackClock() {
  fallbackStart = performance.now();
  fallbackPauseOffset = 0;
  fallbackPausedAt = 0;
  console.log('[Audio] Using fallback clock (no music).');
}

/**
 * 暂停游戏时钟（冻结 songTime）
 * - 有 AudioContext → suspend() 冻结 currentTime
 * - 回退时钟 → 记录暂停时刻
 */
export async function pauseGameClock() {
  if (audioContext && audioContext.state === 'running') {
    await audioContext.suspend();
    console.log('[Audio] Clock paused (AudioContext suspended).');
  }
  if (fallbackStart > 0) {
    fallbackPausedAt = performance.now();
    console.log('[Audio] Fallback clock paused.');
  }
}

/**
 * 恢复游戏时钟
 */
export async function resumeGameClock() {
  if (audioContext && audioContext.state === 'suspended') {
    await audioContext.resume();
    console.log('[Audio] Clock resumed (AudioContext resumed).');
  }
  if (fallbackPausedAt > 0) {
    fallbackPauseOffset += performance.now() - fallbackPausedAt;
    fallbackPausedAt = 0;
    console.log('[Audio] Fallback clock resumed.');
  }
}

/**
 * 歌曲播放结束回调（由 main.js 设置）
 * @type {Function | null}
 */
let _onSongEnd = null;

/**
 * 设置歌曲结束回调（避免 ES module import 只读限制）
 * @param {Function | null} fn
 */
export function setOnSongEnd(fn) {
  _onSongEnd = fn;
}

// ═══════════════════════════════════════════════════
// 节拍状态（供 scoring.js 使用）
// ═══════════════════════════════════════════════════

let bpm = 120;
let beatInterval = 60 / bpm;

// ═══════════════════════════════════════════════════
// 内部函数
// ═══════════════════════════════════════════════════

/**
 * 获取或创建 AudioContext（必须在用户手势后首次调用）
 */
function ensureContext() {
  if (!audioContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioContext = new Ctor();
  }
  return audioContext;
}

/**
 * 安全停止当前 sourceNode
 */
function stopSource() {
  if (!sourceNode) return;
  try {
    sourceNode.stop();
  } catch (_) {
    // 已经停止或从未启动，忽略
  }
  sourceNode.disconnect();
  sourceNode = null;
}

// ═══════════════════════════════════════════════════
// 公开 API — 音乐播放
// ═══════════════════════════════════════════════════

/**
 * 加载并解码音频文件
 *
 * 若加载失败不会 throw，而是返回 false，
 * 并在控制台输出明确错误信息。
 *
 * @param {string} url — 音频文件路径，例如 '/audio/song.mp3'
 * @returns {Promise<boolean>} 是否加载成功
 */
export async function loadMusic(url) {
  try {
    const ctx = ensureContext();
    // 确保 AudioContext 在用户手势下恢复
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    // URL 编码：处理中文、空格、特殊字符
    const encodedUrl = encodeURI(url);
    console.log(`[Audio] Fetching: ${encodedUrl}`);

    const response = await fetch(encodedUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} — ${response.statusText}`);
    }

    // 验证 MIME 类型
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType && !contentType.includes('audio/') && !contentType.includes('octet-stream')) {
      console.warn(`[Audio] Unexpected Content-Type: "${contentType}" — continuing anyway.`);
    }

    const arrayBuffer = await response.arrayBuffer();
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    duration = audioBuffer.duration;

    console.log(
      `[Audio] Loaded "${url}"  (${duration.toFixed(1)}s, ${ctx.sampleRate}Hz)`
    );
    return true;
  } catch (err) {
    console.error(
      `[Audio] Failed to load "${url}" — ${err.message}`
    );
    console.error(
      '[Audio] Hint: place .mp3 files in public/studio/, run "npm run songs", then reload.'
    );
    return false;
  }
}

/**
 * 开始播放音乐
 *
 * @param {number} [offset=0] — 起始偏移量 (秒)
 */
export function startMusic(offset = 0) {
  if (!audioBuffer) {
    console.warn('[Audio] startMusic() called but no audio is loaded.');
    return;
  }

  const ctx = ensureContext();

  // 处理浏览器自动播放策略
  if (ctx.state === 'suspended') {
    ctx.resume();
  }

  // 停止之前的 source（如果有）
  stopSource();

  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = audioBuffer;

  musicGainNode = ctx.createGain();
  musicGainNode.gain.value = 1.0;
  sourceNode.connect(musicGainNode);
  musicGainNode.connect(ctx.destination);

  startOffset = offset;
  sourceNode.start(0, offset);
  startTime = ctx.currentTime;
  playing = true;

  sourceNode.onended = () => {
    playing = false;
    console.log('[Audio] Playback finished.');
    if (_onSongEnd) _onSongEnd();
  };

  console.log(`[Audio] Playing from ${offset.toFixed(1)}s`);
}

/**
 * 停止播放
 */
export function stop() {
  playing = false;
  stopSource();
}

/**
 * 返回当前播放时间
 *
 * @returns {number} 当前播放位置 (秒)
 */
export function getSongTime() {
  // 音乐正常播放 → 用 AudioContext 时钟（suspend 时 currentTime 冻结）
  if (playing && audioContext) {
    return audioContext.currentTime - startTime + startOffset;
  }
  // 回退时钟 → 用 performance.now()，减去暂停累计偏移
  if (fallbackStart > 0) {
    const now = fallbackPausedAt > 0 ? fallbackPausedAt : performance.now();
    return (now - fallbackStart - fallbackPauseOffset) / 1000 + startOffset;
  }
  return startOffset;
}

/**
 * 是否正在播放
 *
 * @returns {boolean}
 */
export function isPlaying() {
  return playing;
}

/**
 * 设置音乐音量（0~1），用于暂停时降低音量
 */
export function setMusicVolume(vol) {
  if (musicGainNode) {
    musicGainNode.gain.value = Math.max(0, Math.min(1, vol));
  }
}

/**
 * 返回已加载音频的总时长（秒）
 *
 * @returns {number} 音频时长，未加载时返回 0
 */
export function getDuration() {
  return duration;
}

/**
 * 音乐是否已播放完毕
 *
 * 基于 getSongTime() >= duration 判断，独立于 onended 事件。
 * 未加载音频时返回 false。
 *
 * @returns {boolean}
 */
export function hasEnded() {
  if (duration <= 0) return false;
  return getSongTime() >= duration;
}

// ═══════════════════════════════════════════════════
// 公开 API — 节拍
// ═══════════════════════════════════════════════════

/**
 * 设置节拍 BPM
 *
 * @param {number} newBpm
 */
export function setBPM(newBpm) {
  bpm = newBpm;
  beatInterval = 60 / bpm;
  console.log(`[Audio] BPM set to ${bpm}  (beat interval = ${beatInterval.toFixed(3)}s)`);
}

/**
 * 获取最近节拍信息
 *
 * @returns {{ beatIndex: number, timeToBeat: number, nearestBeatTime: number }}
 */
export function getNearestBeat() {
  const currentTime = getSongTime();
  const beatIndex = Math.round(currentTime / beatInterval);
  const nearestBeatTime = beatIndex * beatInterval;
  const timeToBeat = currentTime - nearestBeatTime;

  return { beatIndex, timeToBeat, nearestBeatTime };
}

// ═══════════════════════════════════════════════════
// 公开 API — 音效 (SFX)
// ═══════════════════════════════════════════════════

/** @type {Map<string, AudioBuffer>} */
const sfxBuffers = new Map();

/**
 * 加载短音效文件
 *
 * 文件不存在时输出 warning 并返回 false，不阻塞程序。
 *
 * @param {string} name   — 音效标识，如 'shoot' / 'hit'
 * @param {string} url    — 文件路径
 * @returns {Promise<boolean>}
 */
export async function loadSfx(name, url) {
  try {
    const ctx = ensureContext();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    sfxBuffers.set(name, audioBuffer);
    console.log(`[Audio] SFX loaded: "${name}" (${audioBuffer.duration.toFixed(2)}s)`);
    return true;
  } catch (err) {
    console.warn(`[Audio] SFX "${name}" missing at "${url}" — skipping.`);
    return false;
  }
}

/**
 * 播放已加载的音效
 *
 * 使用独立的 AudioBufferSourceNode，不影响音乐播放。
 *
 * @param {string} name   — loadSfx 时注册的名称
 * @param {number} [volume=0.5] — 音量 0~1
 */
export function playSfx(name, volume = 0.5) {
  const buffer = sfxBuffers.get(name);
  if (!buffer) return;

  const ctx = ensureContext();
  if (ctx.state === 'suspended') ctx.resume();

  const source = ctx.createBufferSource();
  const gain = ctx.createGain();

  source.buffer = buffer;
  gain.gain.value = Math.max(0, Math.min(1, volume));

  source.connect(gain);
  gain.connect(ctx.destination);

  source.start(0);

  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };
}

// ═══════════════════════════════════════════════════
// 公开 API — 程序化枪声
// ═══════════════════════════════════════════════════

/**
 * 程序化生成枪声音效（不依赖外部 .wav 文件）
 *
 * 原理：白噪声 + 指数衰减包络 + 可选的低频正弦波
 *
 * @param {'shoot'|'perfect'|'miss'|'downbeat'} [type='shoot'] - 音色类型
 * @param {number} [volume=0.25] - 音量 0~1
 */
export function playGunSound(type = 'shoot', volume = 0.25) {
  const ctx = ensureContext();
  if (ctx.state === 'suspended') ctx.resume();

  const dur = { shoot: 0.06, perfect: 0.08, miss: 0.10, downbeat: 0.14 }[type] || 0.06;
  const decayRate = { shoot: 50, perfect: 60, miss: 25, downbeat: 35 }[type] || 50;

  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(dur * sampleRate));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t * decayRate);

    // 白噪声 → 清脆的咔嚓声
    const noise = (Math.random() * 2 - 1) * env;

    // 低频 punch（仅 downbeat）
    let punch = 0;
    if (type === 'downbeat') {
      punch = Math.sin(2 * Math.PI * 70 * t) * env * 0.5;
    } else if (type === 'miss') {
      // miss 声音更闷 — 削弱高频
      punch = Math.sin(2 * Math.PI * 120 * t) * env * 0.15;
    }

    data[i] = Math.max(-1, Math.min(1, noise * 0.7 + punch));
  }

  const source = ctx.createBufferSource();
  const gain = ctx.createGain();

  source.buffer = buffer;
  gain.gain.value = Math.max(0, Math.min(1, volume));

  source.connect(gain);
  gain.connect(ctx.destination);
  source.start(0);

  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };
}

// ═══════════════════════════════════════════════════
// 公开 API — 激光持续音效
// ═══════════════════════════════════════════════════

let laserOsc = null;
let laserGain = null;

/**
 * 启动激光持续嗡鸣（极低音量，不盖音乐）
 */
export function startLaserHum() {
  if (laserOsc) return;
  const ctx = ensureContext();
  if (ctx.state === 'suspended') ctx.resume();

  laserOsc = ctx.createOscillator();
  laserGain = ctx.createGain();

  laserOsc.type = 'sawtooth';
  laserOsc.frequency.value = 120; // 低嗡鸣
  laserGain.gain.value = 0.03;    // 极低音量

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 400;

  laserOsc.connect(filter);
  filter.connect(laserGain);
  laserGain.connect(ctx.destination);
  laserOsc.start(0);
}

/**
 * 停止激光嗡鸣
 */
export function stopLaserHum() {
  if (!laserOsc) return;
  try { laserOsc.stop(); } catch (_) { /* ignore */ }
  laserOsc.disconnect();
  laserGain.disconnect();
  laserOsc = null;
  laserGain = null;
}

/**
 * 播放一个短促的节拍器 click 音效
 * @param {number} [volume=0.3]
 */
export function playMetronomeClick(volume = 0.3) {
  const ctx = ensureContext();
  if (ctx.state === 'suspended') ctx.resume();

  const dur = 0.04;
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(dur * sampleRate));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 80);
    data[i] = Math.sin(2 * Math.PI * 1000 * t) * env * 0.6
            + Math.sin(2 * Math.PI * 1500 * t) * env * 0.4;
  }

  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  gain.gain.value = Math.max(0, Math.min(1, volume));
  source.connect(gain);
  gain.connect(ctx.destination);
  source.start(0);
  source.onended = () => { source.disconnect(); gain.disconnect(); };
}

export { bpm, beatInterval };
