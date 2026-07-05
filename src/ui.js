/**
 * ui.js — 游戏 UI 模块
 *
 * 管理：开始界面、准星、分数、连击、判定文字、节拍指示器
 *
 * 导出：
 *   initUI()
 *   showStartScreen()
 *   hideStartScreen()
 *   updateScore(score)
 *   updateCombo(combo)
 *   showJudgment(text)
 *   updateBeatIndicator(progress, onBeat)
 *   setCrosshairState(state)
 */

// ═══════════════════════════════════════════════════
// 菜单状态机
// ═══════════════════════════════════════════════════

/** @type {'home'|'playing'|'pause'|'result'|'calibration'|'editor'} */
let menuState = 'home';

/** @type {Function|null} 状态变化回调 */
let _onMenuChange = null;

export function getMenuState() { return menuState; }

export function onMenuChange(fn) { _onMenuChange = fn; }

export function setMenuState(state) {
  if (state === menuState) return;
  const prev = menuState;
  menuState = state;

  // 隐藏所有菜单面板
  document.querySelectorAll('.menu-panel').forEach(el => el.classList.remove('active'));
  document.getElementById('start-screen').style.display = 'none';
  document.getElementById('result-screen').style.display = 'none';
  document.getElementById('resume-overlay').style.display = 'none';

  // 显示对应面板
  switch (state) {
    case 'home':
      document.getElementById('start-screen').style.display = 'flex';
      break;
    case 'playing':
      document.getElementById('start-screen').style.display = 'none';
      break;
    case 'pause':
      document.getElementById('pause-menu').classList.add('active');
      break;
    case 'result':
      document.getElementById('result-screen').style.display = 'flex';
      break;
    case 'calibration':
      document.getElementById('calibration-menu').classList.add('active');
      break;
    case 'editor':
      document.getElementById('editor-screen').classList.add('active');
      break;
  }

  if (_onMenuChange) _onMenuChange(state, prev);
  console.log(`[Menu] ${prev} → ${state}`);
}

// ═══════════════════════════════════════════════════
// DOM 缓存
// ═══════════════════════════════════════════════════

let startScreenEl;
let scoreEl;
let comboEl;
let judgmentEl;
let currentCombo = 0;
let judgmentTimer = null;
let _judgmentShownAt = 0;
let beatEl;
let beatRingEl;
let crosshairEl;

function cacheElements() {
  startScreenEl = document.getElementById('start-screen');
  scoreEl = document.getElementById('score-display');
  comboEl = document.getElementById('combo-display');
  judgmentEl = document.getElementById('judgment-display');
  beatEl = document.getElementById('beat-indicator');
  beatRingEl = document.getElementById('beat-ring');
  crosshairEl = document.getElementById('crosshair');
}

// ═══════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════

/**
 * 初始化 UI（缓存 DOM 引用，绑定全局事件）
 */
export function initUI() {
  cacheElements();

  // 射击事件（仅左键 mousedown + pointer lock 检查）
  document.addEventListener('mousedown', (event) => {
    if (event.button === 0 && document.pointerLockElement) {
      window.dispatchEvent(new CustomEvent('player-shoot'));
    }
  });

  // 键盘 R 键重置
  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyR') {
      window.dispatchEvent(new CustomEvent('player-reset'));
    }
  });
}

/**
 * 显示开始界面
 */
export function showStartScreen() {
  if (startScreenEl) {
    startScreenEl.style.display = 'flex';
  }
}

/**
 * 隐藏开始界面
 */
export function hideStartScreen() {
  if (startScreenEl) {
    startScreenEl.style.display = 'none';
  }
}

/**
 * 更新分数显示
 * @param {number} score
 */
export function updateScore(score) {
  if (scoreEl) {
    scoreEl.textContent = `Score: ${score}`;
  }
}

/**
 * 更新连击显示
 *
 * combo >= 2 时显示洋红色连击数并弹跳；
 * combo <= 1 时隐藏。
 *
 * @param {number} combo
 */
export function updateCombo(combo) {
  if (!comboEl) return;

  if (combo >= 2) {
    comboEl.textContent = `${combo}x`;
    comboEl.style.opacity = '1';
    // 弹跳反馈
    comboEl.style.transform = 'scale(1.35)';
    requestAnimationFrame(() => {
      comboEl.style.transform = 'scale(1)';
    });
  } else {
    comboEl.style.opacity = '0';
  }

  currentCombo = combo;
}

/**
 * 显示判定文字，0.4 秒后淡出
 *
 * @param {'Perfect' | 'Good' | 'Hit' | 'Miss'} text
 */
export function showJudgment(text) {
  if (!judgmentEl) return;

  // 清除旧定时器
  if (judgmentTimer) clearTimeout(judgmentTimer);

  // 重置样式（防止被 combo/slide 显示修改）
  judgmentEl.style.fontSize = '38px';
  judgmentEl.textContent = text;

  // 赛博霓虹配色 + 阴影
  switch (text) {
    case 'Perfect':
      judgmentEl.style.color = '#ffffff';
      judgmentEl.style.fontSize = '42px';
      judgmentEl.style.textShadow =
        '0 0 20px rgba(0, 255, 255, 1), 0 0 50px rgba(0, 255, 255, 0.7), 0 0 80px rgba(0, 255, 255, 0.4)';
      judgmentEl.style.transform = 'scale(1.3)';
      requestAnimationFrame(() => {
        judgmentEl.style.transition = 'transform 0.15s ease-out';
        judgmentEl.style.transform = 'scale(1)';
      });
      break;
    case 'Good':
      judgmentEl.style.color = '#00ff88';
      judgmentEl.style.textShadow =
        '0 0 12px rgba(0, 255, 136, 0.9), 0 0 28px rgba(0, 255, 136, 0.4)';
      break;
    case 'Hit':
      judgmentEl.style.color = '#ffffff';
      judgmentEl.style.textShadow =
        '0 0 8px rgba(255, 255, 255, 0.6), 0 0 18px rgba(255, 255, 255, 0.2)';
      break;
    case 'Miss':
      judgmentEl.style.color = '#ff3333';
      judgmentEl.style.textShadow =
        '0 0 12px rgba(255, 51, 51, 0.8), 0 0 26px rgba(255, 51, 51, 0.35)';
      break;
    default:
      judgmentEl.style.color = '#ffffff';
      judgmentEl.style.textShadow = 'none';
  }

  // 弹入
  judgmentEl.style.opacity = '1';
  judgmentEl.style.transform = 'translate(-50%, -50%) scale(1.2)';

  requestAnimationFrame(() => {
    judgmentEl.style.transition = 'opacity 0.25s ease, transform 0.12s ease';
    judgmentEl.style.transform = 'translate(-50%, -50%) scale(1)';
  });

  // 记录显示时刻，防止被其他 UI 覆盖
  _judgmentShownAt = performance.now();

  // 0.4 秒后淡出
  if (judgmentTimer) clearTimeout(judgmentTimer);
  judgmentTimer = setTimeout(() => {
    judgmentEl.style.opacity = '0';
    _judgmentShownAt = 0;
  }, 400);
}

/**
 * 更新节拍指示器
 *
 * @param {number}  beatProgress - 当前拍内进度 (0 ~ 1)
 * @param {boolean} onBeat       - 是否在拍点上
 */
export function updateBeatIndicator(beatProgress, onBeat) {
  if (!beatEl) return;

  const scale = onBeat ? 1.35 : 0.8 + beatProgress * 0.4;

  beatEl.style.transform = `translateX(-50%) scale(${scale})`;
  beatEl.style.borderColor = onBeat
    ? 'rgba(0, 255, 255, 0.9)'
    : 'rgba(0, 255, 255, 0.25)';
  beatEl.style.backgroundColor = onBeat
    ? 'rgba(0, 255, 255, 0.12)'
    : 'transparent';
}

/**
 * 更新准星外围的节拍环
 *
 * 环从最大（progress=0，正拍）收缩到准星大小（progress→1），
 * 下一个拍点到达时重新扩大 + 闪光。
 *
 * @param {number}  progress          - 当前拍内进度 (0 ~ 1)
 * @param {boolean} isDownbeat        - 是否为 downbeat（每 4 拍第一拍）
 * @param {boolean} [beatJustHappened] - 是否刚进入新拍（触发闪光）
 */
export function updateBeatRing(progress, isDownbeat, beatJustHappened = false) {
  if (!beatRingEl) return;

  // ── 尺寸：从最大 (progress=0) 收缩到最小 (progress=1) ──
  const maxSize = 100;
  const minSize = 18;
  const clamped = Math.max(0, Math.min(1, progress));
  const size = maxSize + (minSize - maxSize) * clamped;

  beatRingEl.style.width = size + 'px';
  beatRingEl.style.height = size + 'px';

  // ── 颜色 ────────────────────────────────────────
  const borderColor = isDownbeat
    ? 'rgba(255, 0, 255, 0.7)'
    : 'rgba(0, 255, 255, 0.5)';

  const glowColor = isDownbeat
    ? 'rgba(255, 0, 255, 0.4)'
    : 'rgba(0, 255, 255, 0.3)';

  beatRingEl.style.borderColor = borderColor;
  beatRingEl.style.boxShadow =
    `0 0 ${isDownbeat ? 14 : 10}px ${glowColor}, ` +
    `inset 0 0 ${isDownbeat ? 8 : 5}px ${glowColor}`;

  // ── 闪光 ────────────────────────────────────────
  if (beatJustHappened) {
    beatRingEl.classList.remove('flash');
    void beatRingEl.offsetWidth; // 强制回流，使动画重新触发
    beatRingEl.classList.add('flash');
  }
}

/**
 * 准星命中/未命中反馈
 *
 * @param {'default' | 'hit' | 'miss'} state
 */
export function setCrosshairState(state) {
  if (!crosshairEl) return;

  switch (state) {
    case 'hit':
      crosshairEl.style.color = 'rgba(0, 255, 255, 1)';
      crosshairEl.style.fontSize = '30px';
      break;
    case 'miss':
      crosshairEl.style.color = 'rgba(255, 0, 255, 1)';
      crosshairEl.style.fontSize = '20px';
      break;
    default:
      crosshairEl.style.color = 'rgba(0, 255, 255, 0.85)';
      crosshairEl.style.fontSize = '26px';
  }

  if (state !== 'default') {
    setTimeout(() => setCrosshairState('default'), 120);
  }
}

/**
 * 显示结算界面
 *
 * @param {{ score: number, maxCombo: number, perfect: number, good: number, miss: number, accuracy: number, rank: string }} state
 */
export function showResultScreen(state) {
  const screen = document.getElementById('result-screen');
  if (!screen) return;

  // 填充数据
  const rankEl = document.getElementById('result-rank');
  const scoreEl = document.getElementById('r-score');
  const comboEl = document.getElementById('r-maxcombo');
  const perfectEl = document.getElementById('r-perfect');
  const goodEl = document.getElementById('r-good');
  const missEl = document.getElementById('r-miss');
  const accEl = document.getElementById('r-accuracy');

  if (rankEl) {
    rankEl.textContent = state.rank;
    // 评级颜色
    const rankColors = {
      SS: '#ffd700', S: '#ffd700',
      A: '#00ff88', B: '#00ffff', C: '#888888',
    };
    rankEl.style.color = rankColors[state.rank] || '#00ffff';
    rankEl.style.textShadow =
      `0 0 24px ${rankEl.style.color}, 0 0 50px ${rankEl.style.color}`;
  }

  if (scoreEl)   scoreEl.textContent = state.score;
  if (comboEl)   comboEl.textContent = state.maxCombo;
  if (perfectEl) perfectEl.textContent = state.perfect;
  if (goodEl)    goodEl.textContent = state.good;
  if (missEl)    missEl.textContent = state.miss;
  if (accEl)     accEl.textContent = (state.accuracy * 100).toFixed(1) + '%';

  screen.style.display = 'flex';
}

/**
 * 隐藏结算界面
 */
export function hideResultScreen() {
  const screen = document.getElementById('result-screen');
  if (screen) screen.style.display = 'none';
}

/**
 * 更新 offset 显示
 *
 * @param {number} offsetMs — offset 毫秒值
 */
export function updateOffsetDisplay(offsetMs) {
  const el = document.getElementById('offset-display');
  if (!el) return;

  const sign = offsetMs >= 0 ? '+' : '';
  el.textContent = `Offset: ${sign}${offsetMs}ms`;
}

/**
 * 射击时准星脉冲动画 — 快速放大再恢复
 */
export function triggerCrosshairPulse() {
  if (!crosshairEl) return;

  crosshairEl.style.transition = 'none';
  crosshairEl.style.transform = 'translate(-50%, -50%) scale(1.7)';

  requestAnimationFrame(() => {
    crosshairEl.style.transition = 'transform 0.12s ease-out';
    crosshairEl.style.transform = 'translate(-50%, -50%) scale(1)';
  });
}

/**
 * 填充选歌下拉菜单
 *
 * @param {Array<{id:string, title:string, bpm:number}>} songs
 * @param {string} [selectedId] - 默认选中歌曲 id
 * @returns {HTMLSelectElement} select 元素
 */
export function populateSongSelect(songs, selectedId) {
  const select = document.getElementById('song-select');
  const info = document.getElementById('song-info');
  if (!select) return null;

  select.innerHTML = '';

  if (songs.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no songs in /studio)';
    select.appendChild(opt);
    select.disabled = true;
    if (info) info.textContent = 'Place .mp3 files in public/studio/ then run: npm run songs';
    return select;
  }

  select.disabled = false;

  for (const s of songs) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.title}  (${s.bpm} BPM)`;
    if (s.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }

  if (info) {
    const sel = songs.find(s => s.id === (selectedId || songs[0]?.id));
    if (sel) {
      info.textContent = `BPM: ${sel.bpm}  Offset: ${sel.offset}ms`;
    }
  }

  return select;
}

/**
 * 根据选歌 ID 更新 song-info 显示
 */
export function updateSongInfo(songs, selectedId) {
  const info = document.getElementById('song-info');
  if (!info) return;
  const sel = songs.find(s => s.id === selectedId);
  if (sel) {
    info.textContent = `BPM: ${sel.bpm}  Offset: ${sel.offset}ms`;
  }
}

/**
 * 更新激光热量条
 * @param {number} heat — 0~100
 */
export function updateHeatBar(heat) {
  const wrap = document.getElementById('heat-bar-wrap');
  const bar = document.getElementById('heat-bar');
  if (!wrap || !bar) return;

  const pct = Math.max(0, Math.min(100, heat));
  bar.style.width = pct + '%';

  if (heat > 0) {
    wrap.style.opacity = '1';
  } else {
    wrap.style.opacity = '0';
  }

  if (heat >= 95) {
    // 过热警告：红色闪烁
    bar.style.background = '#ff1111';
    bar.style.boxShadow = '0 0 8px rgba(255,0,0,0.8)';
  } else if (heat >= 80) {
    bar.style.background = '#ff3333';
    bar.style.boxShadow = '0 0 4px rgba(255,50,0,0.5)';
  } else if (heat >= 60) {
    bar.style.background = '#ff8800';
    bar.style.boxShadow = 'none';
  } else {
    bar.style.background = '#00ffff';
    bar.style.boxShadow = 'none';
  }
}

/**
 * 显示 slide 靶子追踪充能
 * @param {number} charge — 0~1
 */
export function showSlideCharge(charge) {
  const el = document.getElementById('judgment-display');
  if (!el) return;

  if (charge <= 0) {
    el.textContent = '';
    el.style.opacity = '0';
    return;
  }

  const pct = (charge * 100).toFixed(0);
  const bar = '█'.repeat(Math.floor(charge * 10)) + '░'.repeat(10 - Math.floor(charge * 10));

  if (charge >= 0.3) {
    el.textContent = `🔒 TRACKING  ${bar}  ${pct}%`;
  } else {
    el.textContent = `SLIDE  ${bar}  ${pct}%`;
  }

  el.style.color = charge >= 0.6 ? '#44ff44' : (charge >= 0.3 ? '#44ff88' : '#88ccaa');
  el.style.opacity = '1';
  el.style.fontSize = '22px';
  el.style.textShadow = charge >= 0.3
    ? '0 0 10px rgba(68, 255, 136, 0.8)'
    : '0 0 6px rgba(68, 255, 136, 0.4)';
}

/**
 * 显示 combo 靶子剩余命中次数
 * @param {number} remaining - 剩余 HP
 * @param {number} maxHp     - 总 HP
 */
export function showComboHp(remaining, maxHp) {
  const el = document.getElementById('judgment-display');
  if (!el) return;
  // 如果 200ms 内有判定文字显示，不要清除
  if (remaining <= 0) {
    if (performance.now() - _judgmentShownAt < 300) return;
    el.textContent = '';
    el.style.opacity = '0';
    return;
  }
  const bar = '█'.repeat(remaining) + '░'.repeat(maxHp - remaining);
  el.textContent = bar;
  el.style.color = '#ff8800';
  el.style.opacity = '1';
  el.style.fontSize = '24px';
  el.style.textShadow =
    '0 0 8px rgba(255, 136, 0, 0.7), 0 0 16px rgba(255, 136, 0, 0.3)';
}
