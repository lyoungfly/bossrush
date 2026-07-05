/**
 * BossRush — 入口
 *
 * 流程：
 *   1. 页面加载 → 预加载谱面
 *   2. 点击 START → 用谱面数据配置 BPM / timing / 靶子
 *   3. 加载并播放音乐
 *   4. 射击 → 节拍判定 + 靶子命中
 *   5. 动画循环驱动 TargetManager + 节拍指示器
 */

import * as THREE from 'three';
import { initScene, render, camera, clock, getGridGroup } from './scene.js';
import { initPlayerControls, updateCamera, triggerScreenShake, isRightMouseDown } from './player.js';
import { initUI, updateBeatIndicator, updateBeatRing, triggerCrosshairPulse, showResultScreen, hideResultScreen, updateOffsetDisplay, populateSongSelect, updateSongInfo, showComboHp, updateHeatBar, showSlideCharge, setMenuState, getMenuState, onMenuChange } from './ui.js';
import { loadMusic, startMusic, stop as stopMusic, getSongTime, setBPM, setOnSongEnd, startFallbackClock, isPlaying, getDuration, hasEnded, playGunSound, startLaserHum, stopLaserHum, setMusicVolume, pauseGameClock, resumeGameClock, playMetronomeClick } from './audio.js';
import {
  setTimingConfig,
  getNearestBeatInfo,
  applyJudgment,
  applyComboHit,
  applyComboDestroy,
  applyComboPartial,
  applyLaserTick,
  applySlideTick,
  applySlideSuccess,
  applySlideFail,
  resetScore,
  getScoreState,
} from './scoring.js';
import { targetManager, setRingColor } from './targets.js';
import { shoot } from './shooting.js';
import { loadChart } from './chart.js';
import { generateAutoChart } from './chartGenerator.js';
import { effectManager } from './effects.js';
import { loadSongLibrary, getSongs, getSelectedSong, selectSong } from './songLibrary.js';

// ═══ 1. 容器 ═════════════════════════════════════
const container = document.getElementById('game-container');

// ═══ 2. 初始化场景 ═══════════════════════════════
const { camera: cam, scene: scn, renderer: rnd, clock: clk } =
  initScene(container);

// ═══ 3. 初始化第一人称视角 ═════════════════════════
initPlayerControls(cam, rnd.domElement);

// ═══ 4. 初始化 UI ═════════════════════════════════
initUI();

// ── 菜单状态变化 → pointer lock + 音量控制 ────
onMenuChange(async (state, prev) => {
  if (state === 'playing') {
    await resumeGameClock();
    setMusicVolume(1.0);
    if (!document.pointerLockElement) {
      // 浏览器要求两次 pointer lock 之间有间隔
      setTimeout(() => rnd.domElement.requestPointerLock(), 100);
    }
  } else if (prev === 'playing') {
    await pauseGameClock();
    setMusicVolume(0.2);
    if (document.pointerLockElement) document.exitPointerLock();
  }
  if (state === 'home' || state === 'result') {
    setMusicVolume(1.0);
    if (state === 'home') stopMusic();
  }
  // 进入编辑器 → 释放指针锁
  if (state === 'editor') {
    if (document.pointerLockElement) document.exitPointerLock();
    // 填充歌曲列表
    const sel = document.getElementById('editor-song-select');
    if (sel && sel.options.length === 0 && songLibrary.length > 0) {
      for (const s of songLibrary) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.title;
        sel.appendChild(opt);
      }
    }
  }
});

// ── 用指定谱面启动游戏 ─────────────────────
async function _startGameWithChart(customChart, musicFile) {
  audioStarted = true;

  chart = customChart;
  chartBpm = chart.bpm;
  chartOffset = chart.offset || 0;
  effectiveOffset = chartOffset + userOffset;

  setBPM(chartBpm);
  setTimingConfig({
    bpm: chartBpm,
    offset: effectiveOffset,
    perfectWindow: 0.060, // ±60ms — 外环刚接触靶子边缘的前后
    goodWindow: 0.140,   // ±140ms — 接近即可得 Good
  });
  targetManager.setChart(chart);

  // SFX 已改用程序化 playGunSound，无需外部 wav

  const ok = await loadMusic(musicFile);
  if (ok) {
    setOnSongEnd(() => { endGame(); });
    startMusic(chart.offset || 0);
  } else {
    startFallbackClock();
  }

  console.log(`[Game] Custom chart — ${chart.targets.length} targets, BPM=${chartBpm}`);
}

// ── Esc 暂停/返回 ───────────────────────────
window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape') {
    const st = getMenuState();
    if (st === 'playing') setMenuState('pause');
    else if (st === 'pause') setMenuState('playing');
    else if (st === 'calibration') setMenuState('home');
    else if (st === 'editor') {
      if (_editor.playback === 'playing' || _editor.playback === 'paused') stopMusic();
      _resetEditorUI();
      setMenuState('home');
    }
  }
});

// ── 暂停菜单按钮 ────────────────────────────
document.getElementById('pause-resume-btn')?.addEventListener('click', () => {
  setMenuState('playing');
});
document.getElementById('pause-restart-btn')?.addEventListener('click', () => {
  _restartGame();
  setMenuState('playing');
});
document.getElementById('pause-home-btn')?.addEventListener('click', () => {
  _goHome();
});
document.getElementById('pause-calibrate-btn')?.addEventListener('click', () => {
  setMenuState('calibration');
});

// ── 校准菜单按钮 ────────────────────────────
// ── 编辑器状态机 ───────────────────────────
const _editor = {
  playback: 'idle',
  recording: false,
  targets: [],
  _previewMeshes: [],   // 3D 场景中的预览靶子
  songBpm: 120,
  songOffset: 0,
  songFile: '',
  songDuration: 0,
  _timeEl: null,
  _lastClickTime: 0,    // 点合并：上次点击时间
};

function _editorSetPlayback(st) {
  _editor.playback = st;
  const playBtn  = document.getElementById('editor-play-btn');
  const pauseBtn = document.getElementById('editor-pause-btn');
  const stopBtn  = document.getElementById('editor-stop-btn-pb');
  const recBtn   = document.getElementById('editor-rec-start-btn');
  const stopRec  = document.getElementById('editor-rec-stop-btn');
  const loadBtn  = document.getElementById('editor-load-btn');

  const hasSong = _editor.playback !== 'idle';
  const isPlaying = st === 'playing';
  const isPaused = st === 'paused';
  const isRec = _editor.recording;

  if (playBtn)  playBtn.disabled  = !hasSong || isPlaying || isRec;
  if (pauseBtn) pauseBtn.disabled = !isPlaying || isRec;
  if (stopBtn)  stopBtn.disabled  = !hasSong || st === 'idle';
  if (recBtn)   recBtn.disabled   = !hasSong || isRec;
  if (loadBtn)  loadBtn.disabled  = isPlaying || isRec;

  if (isRec && stopRec) {
    stopRec.style.display = '';
    if (recBtn) recBtn.style.display = 'none';
  }
}

function _editorShowStatus(msg, color) {
  const el = document.getElementById('editor-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || '#44ff44';
}

function _editorUpdateTimeDisplay() {
  if (!_editor._timeEl) _editor._timeEl = document.getElementById('editor-time-display');
  const el = _editor._timeEl;
  if (!el) return;

  if (_editor.playback === 'idle') {
    el.textContent = '--:-- / --:--';
    return;
  }

  const cur = getSongTime();
  const dur = _editor.songDuration;
  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };
  el.textContent = `${fmt(cur)} / ${fmt(dur)}`;

  // 播放完毕自动停止
  if (_editor.playback === 'playing' && cur >= dur && dur > 0) {
    stopMusic();
    _editorSetPlayback('loaded');
    _editorShowStatus('Playback finished.', '#44ff88');
  }
}

function _resetEditorUI() {
  document.getElementById('editor-export-btn').style.display = 'none';
  document.getElementById('editor-test-btn').style.display = 'none';
  document.getElementById('editor-rec-stop-btn').style.display = 'none';
  document.getElementById('editor-rec-start-btn').style.display = '';
  document.getElementById('editor-rec-start-btn').disabled = true;
  document.getElementById('editor-rec-edit').style.display = 'none';
  document.getElementById('editor-status').textContent = '';
  document.getElementById('editor-time-display').textContent = '--:-- / --:--';
  _editor.recording = false;
  _editor.targets = [];
  _editorClearPreviews();
  _editor.playback = 'idle';
  _editor.songDuration = 0;
  _editorSetPlayback('idle');
}

// ── 进入编辑器 ─────────────────────────────
document.getElementById('home-editor-btn')?.addEventListener('click', () => {
  const sel = document.getElementById('editor-song-select');
  if (sel && sel.options.length === 0 && songLibrary.length > 0) {
    for (const s of songLibrary) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.title;
      sel.appendChild(opt);
    }
  }
  _resetEditorUI();
  setMenuState('editor');
});

// 选歌变化 → 显示歌曲信息
document.getElementById('editor-song-select')?.addEventListener('change', () => {
  const songId = document.getElementById('editor-song-select').value;
  const song = songLibrary.find(s => s.id === songId);
  const detail = document.getElementById('editor-song-detail');
  if (song && detail) {
    detail.textContent = `File: ${song.file}  |  BPM: ${song.bpm}  Offset: ${song.offset}ms`;
    document.getElementById('editor-bpm').value = song.bpm;
    document.getElementById('editor-offset').value = song.offset;
  }
});

// Load Song
document.getElementById('editor-load-btn')?.addEventListener('click', async () => {
  const songId = document.getElementById('editor-song-select')?.value;
  const song = songLibrary.find(s => s.id === songId);
  if (!song) {
    _editorShowStatus('No song selected.', '#ff3333');
    return;
  }

  _editor.songBpm = parseInt(document.getElementById('editor-bpm')?.value) || 120;
  _editor.songOffset = parseFloat(document.getElementById('editor-offset')?.value) || 0;
  _editor.songFile = song.file;
  _editor.targets = [];

  _editorShowStatus('Loading...', '#ffff00');
  const ok = await loadMusic(song.file);
  if (!ok) {
    _editorShowStatus(`Failed to load: ${song.file}`, '#ff3333');
    return;
  }

  _editor.songDuration = getDuration();
  _editor.playback = 'loaded';
  _editorSetPlayback('loaded');
  _editorShowStatus(`Loaded: ${song.title} (${_editor.songDuration.toFixed(1)}s)`, '#44ff88');
  _editorUpdateTimeDisplay();
});

// Play
document.getElementById('editor-play-btn')?.addEventListener('click', () => {
  if (_editor.playback === 'paused') {
    resumeGameClock();
    setMusicVolume(1.0);
  } else {
    startMusic(0);
  }
  _editor.playback = 'playing';
  _editorSetPlayback('playing');
  _editorShowStatus('▶ Playing...', '#44ff88');
});

// Pause
document.getElementById('editor-pause-btn')?.addEventListener('click', async () => {
  await pauseGameClock();
  setMusicVolume(0.1);
  _editor.playback = 'paused';
  _editorSetPlayback('paused');
  _editorShowStatus('⏸ Paused', '#ffff00');
});

// Stop
document.getElementById('editor-stop-btn-pb')?.addEventListener('click', () => {
  stopMusic();
  _editor.playback = 'loaded';
  _editorSetPlayback('loaded');
  _editorUpdateTimeDisplay();
  _editorShowStatus('⏹ Stopped', '#888888');
});

// Start Recording
document.getElementById('editor-rec-start-btn')?.addEventListener('click', () => {
  _editor.targets = [];
  _editorClearPreviews();
  _editor.recording = true;
  _editor._lastClickTime = -1;
  _editorSetPlayback(_editor.playback);

  if (_editor.playback !== 'playing') {
    startMusic(0);
    _editor.playback = 'playing';
  }

  document.getElementById('editor-rec-start-btn').style.display = 'none';
  document.getElementById('editor-rec-stop-btn').style.display = '';
  document.getElementById('editor-rec-edit').style.display = '';
  document.getElementById('editor-export-btn').style.display = 'none';
  document.getElementById('editor-test-btn').style.display = 'none';
  _editorUpdateCount();
  _editorShowStatus('● Recording... click to the beat!', '#ff4444');
});

// Stop Recording
document.getElementById('editor-rec-stop-btn')?.addEventListener('click', () => {
  _editor.recording = false;
  _editorSetPlayback(_editor.playback);

  document.getElementById('editor-rec-start-btn').style.display = '';
  document.getElementById('editor-rec-stop-btn').style.display = 'none';
  const n = _editor.targets.length;
  _editorShowStatus(`✓ Saved ${n} target(s).`, '#44ff44');
  if (n > 0) {
    document.getElementById('editor-export-btn').style.display = '';
    document.getElementById('editor-test-btn').style.display = '';
  }
});

// Undo
document.getElementById('editor-undo-btn')?.addEventListener('click', () => {
  _editorUndoLast();
  _editorShowStatus(`Undo — ${_editor.targets.length} target(s) remaining.`, '#ffff00');
});

// Clear
document.getElementById('editor-clear-btn')?.addEventListener('click', () => {
  _editorClearAll();
  _editorShowStatus('All targets cleared.', '#888888');
});

// Export
document.getElementById('editor-export-btn')?.addEventListener('click', () => {
  if (_editor.targets.length === 0) {
    _editorShowStatus('Nothing to export — record some targets first.', '#ff8800');
    return;
  }

  // 按 time 升序排列
  const sorted = [..._editor.targets].sort((a, b) => a.time - b.time);

  // 文件名：歌曲名_日期
  const songName = (songLibrary.find(s => s.file === _editor.songFile)?.title || 'custom')
    .replace(/[^a-zA-Z0-9_\-一-鿿]+/g, '_').slice(0, 30);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = `${songName}_${date}.json`;

  const chart = {
    songId: 'custom_chart',
    songFile: _editor.songFile,
    bpm: _editor.songBpm,
    offset: _editor.songOffset,
    duration: _editor.songDuration,
    spawnLeadTime: 1.0,
    autoGenerate: false,
    targets: sorted,
  };

  const json = JSON.stringify(chart, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);

  _editorShowStatus(`⬇ Exported: ${filename} (${sorted.length} targets)`, '#44ff88');
  console.log(`[Editor] Exported chart:\n${json.slice(0, 500)}...`);
});

// Test
document.getElementById('editor-test-btn')?.addEventListener('click', () => {
  if (_editor.targets.length === 0) return;
  const chart = {
    songId: 'custom_test', bpm: _editor.songBpm, offset: _editor.songOffset,
    duration: _editor.songDuration, autoGenerate: false, spawnLeadTime: 1.0,
    targets: _editor.targets,
  };
  stopMusic();
  _resetEditorUI();
  setMenuState('playing');
  _startGameWithChart(chart, _editor.songFile);
});

// Back
document.getElementById('editor-back-btn')?.addEventListener('click', () => {
  if (_editor.playback === 'playing' || _editor.playback === 'paused') stopMusic();
  _resetEditorUI();
  setMenuState('home');
});

/** 在场景中创建一个临时预览靶子 */
function _editorSpawnPreview(position, type) {
  const colorMap = { normal: 0x00ffff, downbeat: 0xff00ff };
  const color = colorMap[type] || 0x00ffff;

  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(0.15, 12, 12);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.7, depthWrite: false,
  });
  const sphere = new THREE.Mesh(geo, mat);
  group.add(sphere);

  const ringGeo = new THREE.TorusGeometry(0.22, 0.03, 8, 16);
  const ringMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.5, depthWrite: false,
  });
  group.add(new THREE.Mesh(ringGeo, ringMat));

  group.position.set(position[0], position[1], position[2]);
  scn.add(group);
  _editor._previewMeshes.push(group);
}

/** 清除所有预览靶子 */
function _editorClearPreviews() {
  for (const m of _editor._previewMeshes) {
    scn.remove(m);
    m.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
  }
  _editor._previewMeshes = [];
}

/** 撤销最后一个录制点 */
function _editorUndoLast() {
  if (_editor.targets.length === 0) return;
  _editor.targets.pop();
  // 移除最后一个预览 mesh
  const lastMesh = _editor._previewMeshes.pop();
  if (lastMesh) {
    scn.remove(lastMesh);
    lastMesh.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
  }
  _editorUpdateCount();
}

/** 清空全部录制点 */
function _editorClearAll() {
  _editor.targets = [];
  _editorClearPreviews();
  _editorUpdateCount();
}

function _editorUpdateCount() {
  const el = document.getElementById('editor-rec-count');
  if (el) el.textContent = `${_editor.targets.length} target(s)`;
}

// 录制点击（带点合并 + 预览 + 反馈）
function _recordEditorClick(songTime) {
  if (!_editor.recording) return;

  // 点合并：距上次点击 < 0.12s 则跳过
  if (songTime - _editor._lastClickTime < 0.12) return;
  _editor._lastClickTime = songTime;

  const bpm = _editor.songBpm;
  const beatInterval = 60 / bpm;
  const adjusted = songTime - _editor.songOffset;
  const exactBeat = adjusted / beatInterval;
  const beatIndex = Math.round(exactBeat);
  const beatInMeasure = ((beatIndex % 4) + 4) % 4;

  let type = 'normal';
  if (beatInMeasure === 0) type = 'downbeat';

  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const pos = cam.position.clone().add(dir.multiplyScalar(10));
  const position = [
    Math.round(pos.x * 10) / 10,
    Math.round(pos.y * 10) / 10,
    Math.round(pos.z * 10) / 10,
  ];

  const entry = {
    time: Math.round(songTime * 1000) / 1000,
    type,
    position,
  };

  _editor.targets.push(entry);
  _editorSpawnPreview(position, type);
  _editorUpdateCount();

  // 节拍反馈：判定文字 + 枪声
  const showJ = document.getElementById('judgment-display');
  if (showJ) {
    showJ.textContent = type === 'downbeat' ? 'DOWNBEAT' : 'HIT';
    showJ.style.color = type === 'downbeat' ? '#ff00ff' : '#00ffff';
    showJ.style.opacity = '1';
    showJ.style.fontSize = '20px';
    setTimeout(() => { showJ.style.opacity = '0'; }, 300);
  }
  playGunSound(type === 'downbeat' ? 'downbeat' : 'shoot', 0.2);
}

document.getElementById('home-calibrate-btn')?.addEventListener('click', () => {
  setMenuState('calibration');
});
document.getElementById('calib-plus-20')?.addEventListener('click', () => applyUserOffset(+20));
document.getElementById('calib-plus-5')?.addEventListener('click', () => applyUserOffset(+5));
document.getElementById('calib-minus-5')?.addEventListener('click', () => applyUserOffset(-5));
document.getElementById('calib-minus-20')?.addEventListener('click', () => applyUserOffset(-20));
document.getElementById('calib-reset-btn')?.addEventListener('click', () => applyUserOffset(-userOffset * 1000));
document.getElementById('calib-back-btn')?.addEventListener('click', () => {
  _metroState = null; // 停止节拍器
  setMenuState(audioStarted ? 'pause' : 'home');
});

// ── 节拍器校准 ──────────────────────────────
let _metroState = null;

document.getElementById('calib-metro-start')?.addEventListener('click', () => {
  _metroState = { round: 1, offsets: [], beatInterval: 0.5, beatInRound: 0, totalRounds: 6 };
  _metroRunBeat();
});

function _metroRunBeat() {
  if (!_metroState) return;
  const st = _metroState;
  if (st.round > st.totalRounds) {
    const avg = st.offsets.reduce((a, b) => a + b, 0) / st.offsets.length;
    applyUserOffset(Math.round(avg * 1000));
    const el = document.getElementById('calib-metro-status');
    if (el) el.textContent = `Done! Avg: ${Math.round(avg * 1000)}ms (${st.offsets.length} rounds)`;
    _metroState = null;
    return;
  }

  st.beatInRound++;
  if (st.beatInRound > 4) { st.beatInRound = 1; st.round++; }

  playMetronomeClick(st.beatInRound === 1 ? 0.35 : 0.2);
  st.nextBeatTime = performance.now() / 1000;

  const el = document.getElementById('calib-metro-status');
  if (el) el.textContent = `Round ${st.round}/${st.totalRounds} — Beat ${st.beatInRound}/4 ${st.beatInRound === 4 ? '← TAP!' : ''}`;

  if (st.beatInRound === 4) {
    const onTap = (e) => {
      if (e.button !== 0) return;
      if (!_metroState || _metroState.beatInRound !== 4) return;
      _metroState.offsets.push(performance.now() / 1000 - _metroState.nextBeatTime);
      document.removeEventListener('mousedown', onTap);
      setTimeout(() => _metroRunBeat(), 400);
    };
    document.addEventListener('mousedown', onTap);
    setTimeout(() => { document.removeEventListener('mousedown', onTap); if (_metroState?.beatInRound === 4) _metroRunBeat(); }, 1500);
  } else {
    setTimeout(() => _metroRunBeat(), st.beatInterval * 1000);
  }
}

// ═══ 5. 歌曲库 & 难度选择 ═════════════════════════
//
// 默认 Normal，用户点击难度按钮切换。
// 启动时加载歌曲清单，玩家选歌 + 难度后点击 START。
//

/** @type {import('./chart.js').Chart} */
let chart = null;
let chartBpm = 120;
let chartOffset = 0;       // 谱面 offset（自动生成时为 0）
let userOffset = 0;         // 用户校准 offset (秒)
let effectiveOffset = 0;    // chartOffset + userOffset
let currentDifficulty = 'easy';

// 歌曲库
let songLibrary = [];
let selectedSongId = null;

// ── 加载歌曲库并填充 UI ──────────────────────
let _songLibReady = false;
(async () => {
  songLibrary = await loadSongLibrary();

  if (songLibrary.length > 0) {
    selectedSongId = songLibrary[0].id;
    selectSong(selectedSongId);
  }

  populateSongSelect(songLibrary, selectedSongId);

  // 选歌事件
  const songSelect = document.getElementById('song-select');
  if (songSelect) {
    songSelect.addEventListener('change', () => {
      selectedSongId = songSelect.value;
      selectSong(selectedSongId);
      updateSongInfo(songLibrary, selectedSongId);
    });
  }

  _songLibReady = true;
  console.log('[Game] Song library ready.');
})();

// ── localStorage: 读取用户 offset ──────────────
const OFFSET_KEY = 'bossrush_offset';
try {
  const saved = localStorage.getItem(OFFSET_KEY);
  if (saved !== null) {
    userOffset = parseFloat(saved) || 0;
  }
} catch (_) { /* localStorage 不可用 */ }

// 更新 offset 显示
updateOffsetDisplay(Math.round(userOffset * 1000));

const DIFFICULTY_LABELS = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

// 难度按钮 UI 交互
const diffButtons = document.querySelectorAll('.diff-btn');

diffButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    // 更新选中状态
    diffButtons.forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');

    currentDifficulty = btn.dataset.diff;
    console.log(`[Game] Difficulty → ${DIFFICULTY_LABELS[currentDifficulty]}`);
  });
});

// ═══ 6. 靶子过期回调 ═════════════════════════════
targetManager.onMiss = (target) => {
  if (target._partialFail) {
    const hitsLanded = target.maxHitPoints - target.hitPoints;
    showComboHp(0, 0); // 先清除 HP 显示
    applyComboPartial(hitsLanded); // 再显示 Miss 判定（覆盖清除）
    console.log(
      `[Target] Combo partial fail — ${hitsLanded}/${target.maxHitPoints} hits`
    );
  } else if (target._slideFinished) {
    if (target.totalCharge >= 0.6) {
      applySlideSuccess(target.totalCharge);
    } else {
      applySlideFail(target.totalCharge);
    }
    showSlideCharge(0); // 清除 slide 充能条（judgment 已覆盖）
  } else {
    applyJudgment('Miss');
    console.log(
      `[Target] Miss — expired  type=${target.type}  hitTime=${target.hitTime.toFixed(2)}s`
    );
  }
};

// ═══ 歌曲结束 → 结算 ═══════════════════════════
let gameEnded = false;
let _isRestarting = false;
let _climaxActive = false; // 当前是否在高潮段

/** 根据小节号判断歌曲段落（与 chartGenerator 的 getSection 保持一致） */
function getChartSection(measureIdx) {
  const r = measureIdx / Math.max(Math.floor(getDuration() * (chartBpm / 60) / 4), 1);
  if (r < 0.12) return 'intro';
  if (r < 0.38) return 'build';
  if (r < 0.68) return 'drop';
  if (r < 0.85) return 'bridge';
  return 'outro';
}

/**
 * 显示结算界面
 */
function endGame() {
  if (gameEnded) return;
  gameEnded = true;

  // 等 0.3s 让最后靶子过期结算
  setTimeout(() => {
    const state = getScoreState();
    console.log(
      `[Game] Finished — ${state.rank}  score=${state.score}  ` +
      `acc=${(state.accuracy * 100).toFixed(1)}%  maxCombo=${state.maxCombo}`
    );

    showResultScreen(state);
    setMenuState('result');
  }, 300);
}

// audio.js 播放结束时触发
setOnSongEnd(() => {
  endGame();
});

// 关卡结算检测 —— 每帧调用
// 结算条件：音乐播放完毕（hasEnded），或回退时钟走过有效时长
// 绝不由谱面靶子数量 / 是否全部处理完决定结算时机
function checkChartComplete() {
  if (gameEnded || !chart || _isRestarting) return;

  // 音乐还在播放中 → 不结算
  if (isPlaying()) return;

  // 音乐已结束（hasEnded 基于 songTime >= getDuration()）
  if (hasEnded()) {
    endGame();
    return;
  }

  // 回退时钟兜底：无音频时，songTime 走过 chart.duration 即可结算
  if (getDuration() <= 0) {
    const fallbackDuration = (chart.duration > 0) ? chart.duration : 60;
    if (getSongTime() >= fallbackDuration) {
      endGame();
    }
  }
}

// ═══ 调试：谱面覆盖检查 ══════════════════════

/**
 * 输出谱面调试信息，验证关卡是否覆盖完整歌曲。
 *
 * @param {import('./chart.js').Chart} chart
 * @param {Object} meta
 */
function _logChartDebug(chart, meta) {
  const targets = chart.targets || [];
  const targetCount = targets.length;
  const firstTargetTime = targetCount > 0 ? targets[0].time : 0;
  const lastTargetTime  = targetCount > 0 ? targets[targets.length - 1].time : 0;

  // 前 10 个 targets 表格
  if (targetCount > 0) {
    const preview = targets.slice(0, 10).map((t, i) => ({
      '#': i + 1,
      'time (s)': t.time,
      type: t.type,
      'x': t.position[0].toFixed(1),
      'y': t.position[1].toFixed(1),
      'z': t.position[2].toFixed(1),
    }));
    console.table(preview);
  }

  // 摘要信息
  console.log(
    `[ChartDebug] ── Summary ───────────────────────────\n` +
    `  audioDuration   : ${meta.audioDuration.toFixed(1)}s\n` +
    `  chart.duration  : ${meta.chartMetaDuration.toFixed(1)}s\n` +
    `  finalDuration   : ${meta.songDuration.toFixed(1)}s\n` +
    `  BPM             : ${meta.bpm}\n` +
    `  offset          : ${meta.offset}s\n` +
    `  spawnLeadTime   : ${meta.spawnLead}s\n` +
    `  autoGenerated   : ${meta.autoGenerated}\n` +
    `  targetCount     : ${targetCount}\n` +
    `  firstTargetTime : ${firstTargetTime.toFixed(3)}s\n` +
    `  lastTargetTime  : ${lastTargetTime.toFixed(3)}s\n` +
    `  coverage        : ${((lastTargetTime / Math.max(meta.songDuration, 0.001)) * 100).toFixed(1)}%`
  );

  // 覆盖不足警告
  if (lastTargetTime < meta.songDuration - 5) {
    console.warn(
      `[ChartDebug] ⚠ Chart does not cover full song duration. ` +
      `(last=${lastTargetTime.toFixed(1)}s, song=${meta.songDuration.toFixed(1)}s, gap=${(meta.songDuration - lastTargetTime).toFixed(1)}s)`
    );
  } else {
    console.log('[ChartDebug] ✓ Chart coverage OK.');
  }
}

// ═══ START / RESTART 按钮 ═════════════════════
document.getElementById('start-button')?.addEventListener('click', () => {
  setMenuState('playing');
});

function _goHome() {
  _isRestarting = true;
  _climaxActive = false;
  setRingColor(0x00ffff);
  setOnSongEnd(null);
  stopMusic();
  resetScore();
  targetManager.clear();
  effectManager.clear();
  gameEnded = false;
  audioStarted = false;
  laser.heat = 0;
  laser.isActive = false;
  laser.isOverheated = false;
  laser._fadeAlpha = 0;
  _hideAllLaserParts();
  stopLaserHum();
  document.getElementById('game-container').style.boxShadow = '';
  updateHeatBar(0);
  hideResultScreen();
  showComboHp(0, 0);
  showSlideCharge(0);
  setMenuState('home');
  _isRestarting = false;
}

function _restartGame() {
  _isRestarting = true;
  _climaxActive = false;
  setRingColor(0x00ffff);
  setOnSongEnd(null); // 先置空 → 旧 onended 异步触发时为 null
  stopMusic();
  // 不在这里设新回调！等新音乐 startMusic 后再设（见 pointerlockchange）

  resetScore();
  targetManager.clear();
  effectManager.clear();
  gameEnded = false;
  audioStarted = false;
  laser.heat = 0;
  laser.isActive = false;
  laser.isOverheated = false;
  laser._fadeAlpha = 0;
  _hideAllLaserParts();
  stopLaserHum();
  document.getElementById('game-container').style.boxShadow = '';
  updateHeatBar(0);
  hideResultScreen();
}

document.getElementById('restart-button').addEventListener('click', () => {
  _restartGame();
  setMenuState('playing');
});

// ═══ Offset 校准快捷键 ══════════════════════════
/**
 * 更新用户校准 offset 并同步所有依赖
 */
function applyUserOffset(deltaMs) {
  userOffset += deltaMs / 1000;
  // 限制范围 ±500ms
  userOffset = Math.max(-0.5, Math.min(0.5, userOffset));

  effectiveOffset = chartOffset + userOffset;

  // 同步到 scoring
  setTimingConfig({ offset: effectiveOffset });

  // 更新 UI
  updateOffsetDisplay(Math.round(userOffset * 1000));
  const calibEl = document.getElementById('calib-offset-display');
  if (calibEl) calibEl.textContent = `${Math.round(userOffset * 1000)}ms`;

  // 持久化
  try {
    localStorage.setItem(OFFSET_KEY, userOffset);
  } catch (_) { /* ignore */ }

  console.log(
    `[Offset] ${deltaMs > 0 ? '+' : ''}${deltaMs}ms  →  user=${(userOffset * 1000).toFixed(0)}ms  ` +
    `effective=${(effectiveOffset * 1000).toFixed(0)}ms`
  );
}

window.addEventListener('keydown', (event) => {
  // 在游戏过程中才响应
  if (!audioStarted) return;

  switch (event.code) {
    case 'BracketLeft':   // [
      applyUserOffset(-10);
      break;
    case 'BracketRight':  // ]
      applyUserOffset(+10);
      break;
    case 'Backslash':     // \
      applyUserOffset(-userOffset * 1000); // 重置到 0
      break;
  }
});

// ═══ 7. 游戏开始 ═══════════════════════════════
let audioStarted = false;

document.addEventListener('pointerlockchange', async () => {
  if (document.pointerLockElement === rnd.domElement && !audioStarted) {
    _isRestarting = false; // 新游戏已启动，恢复结算检测
    audioStarted = true;

    // ── 1. 加载谱面 JSON ──────────────────────────
    const chartPath = `/charts/${currentDifficulty}.json`;
    console.log(`[Game] Loading chart: ${chartPath}  (${DIFFICULTY_LABELS[currentDifficulty]})`);

    /** @type {import('./chart.js').Chart|null} */
    let chartMeta = null;
    try {
      chartMeta = await loadChart(chartPath);
    } catch (_) {
      chartMeta = null;
    }

    if (!chartMeta) {
      console.error(`[Game] Chart "${chartPath}" failed to load. Cannot start.`);
      document.getElementById('judgment-display').textContent = 'CHART ERROR';
      document.getElementById('judgment-display').style.color = '#ff3333';
      document.getElementById('judgment-display').style.opacity = '1';
      audioStarted = false;
      return;
    }

    // ── 2. 获取选中歌曲信息 ───────────────────────
    const selectedSong = getSelectedSong();
    const musicFile = selectedSong ? selectedSong.file : '/audio/song.mp3';
    const songBpm = selectedSong?.bpm ?? (chartMeta.bpm || 120);
    const songOffset = selectedSong?.offset ?? (chartMeta.offset || 0);

    if (selectedSong) {
      console.log(
        `[Game] Selected song: "${selectedSong.title}"  ` +
        `file=${selectedSong.file}  bpm=${songBpm}  offset=${songOffset}`
      );
    } else {
      console.warn('[Game] No song selected — falling back to /audio/song.mp3');
    }

    // ── 3. 加载音乐，获取真实音频时长 ──────────────
    const musicOk = await loadMusic(musicFile);
    let audioDuration = 0;

    if (musicOk) {
      audioDuration = getDuration();
      console.log(`[Game] Music loaded — audioDuration=${audioDuration.toFixed(1)}s`);
    } else {
      startFallbackClock();
      console.warn(`[Game] Music unavailable (${musicFile}) — fallback clock, no audio.`);
      // UI 可见报错
      const jd = document.getElementById('judgment-display');
      if (jd) {
        jd.textContent = 'NO AUDIO';
        jd.style.color = '#ff3333';
        jd.style.opacity = '1';
        setTimeout(() => { jd.style.opacity = '0'; }, 2000);
      }
    }

    // ── 4. 确定有效歌曲时长 ───────────────────────
    //   audioDuration (真值) > chartMeta.duration > 60s fallback
    let songDuration;
    if (audioDuration > 0) {
      songDuration = audioDuration;
    } else if (chartMeta.duration > 0) {
      songDuration = chartMeta.duration;
    } else {
      console.warn('[Game] No valid duration — using 60s test duration.');
      songDuration = 60;
    }

    // ── 4.5. 检查自定义谱面 ─────────────────────
    const chartSel = document.getElementById('chart-select')?.value;
    const customChart = _getChartBySelect(chartSel || 'auto');
    if (customChart) {
      chartBpm = customChart.bpm; chartOffset = customChart.offset || 0;
      effectiveOffset = chartOffset + userOffset;
      const sl = chartMeta.spawnLeadTime ?? 1.0;
      chart = { songId: 'custom', bpm: chartBpm, offset: chartOffset, duration: customChart.duration || songDuration, spawnLeadTime: sl, autoGenerate: false, targets: customChart.targets, sizeMultiplier: 1.0 };
      console.log(`[Game] CUSTOM CHART "${customChart.name}" — ${chart.targets.length} targets`);
    } else {

    // ── 5. 决定：自动生成 or 手写谱面 ─────────────
    const targetsTooShort =
      chartMeta.targets &&
      chartMeta.targets.length > 0 &&
      chartMeta.targets[chartMeta.targets.length - 1].time < songDuration * 0.3;

    const shouldAutoGenerate =
      chartMeta.autoGenerate === true ||
      !chartMeta.targets ||
      chartMeta.targets.length === 0 ||
      targetsTooShort;

    chartBpm = songBpm;
    chartOffset = songOffset;
    effectiveOffset = chartOffset + userOffset;

    const spawnLead = chartMeta.spawnLeadTime ?? (currentDifficulty === 'hard' ? 0.9 : 1.0);

    if (shouldAutoGenerate) {
      // ★ 自动生成完整谱面
      chart = await generateAutoChart({
        bpm: chartBpm,
        offset: chartOffset,
        duration: songDuration,
        difficulty: currentDifficulty,
        spawnLeadTime: spawnLead,
        useLLM: true,
        llmApiKey: 'sk-b7ae355e244f4d0786503c47cf6caa81',
      });

      console.log(
        `[Game] AUTO-GENERATED  |  BPM=${chartBpm}  ` +
        `duration=${songDuration.toFixed(1)}s  difficulty=${DIFFICULTY_LABELS[currentDifficulty]}  ` +
        `targets=${chart.targets.length}`
      );
    } else {
      // ★ 使用手写谱面
      chart = chartMeta;

      console.log(
        `[Game] MANUAL CHART  |  BPM=${chartBpm}  offset=${chartOffset}s  ` +
        `targets=${chart.targets.length}`
      );
    }

    } // end custom chart else

    // ── 5. 谱面调试信息 ──────────────────────────
    _logChartDebug(chart, {
      audioDuration,
      chartMetaDuration: chartMeta.duration || 0,
      songDuration,
      bpm: chartBpm,
      offset: chartOffset,
      spawnLead,
      autoGenerated: shouldAutoGenerate,
    });

    // targetCount === 0 → 兜底生成 60s 测试谱面
    if (!chart.targets || chart.targets.length === 0) {
      console.error('[Game] Chart has 0 targets! Generating 60s fallback chart.');
      chart = await generateAutoChart({
        bpm: chartBpm,
        offset: chartOffset,
        duration: 60,
        difficulty: currentDifficulty,
        spawnLeadTime: spawnLead,
      });
      targetManager.setChart(chart);
      _logChartDebug(chart, {
        audioDuration,
        chartMetaDuration: 0,
        songDuration: 60,
        bpm: chartBpm,
        offset: chartOffset,
        spawnLead,
        autoGenerated: true,
      });
    }

    // ── 6. 配置全局参数 ──────────────────────────
    setBPM(chartBpm);
    setTimingConfig({
      bpm: chartBpm,
      offset: effectiveOffset,
      perfectWindow: 0.033, // 对齐外环缩到 scale≈1 的瞬间 (±33ms)
      goodWindow: 0.12,
    });
    targetManager.setChart(chart);

    // ── 6. 预加载音效（缺失不阻塞）──────────────────
    // SFX handled by playGunSound (procedural)

    // ── 7. 开始播放 ──────────────────────────────
    if (musicOk) {
      setOnSongEnd(() => { endGame(); }); // 新歌专属回调
      startMusic(chart.offset || 0);
    }
  }
});

// ═══ 8. 射击 ════════════════════════════════════
window.addEventListener('player-shoot', () => {
  const songTime = getSongTime();

  // 编辑器录制模式下，点击录制谱面
  if (_editor.recording) {
    _recordEditorClick(songTime);
    document.getElementById('editor-status').textContent =
      `● Recording... ${_editor.targets.length} target(s)`;
    return;
  }

  const { beatIndex, beatTime, error } = getNearestBeatInfo(songTime);

  const result = shoot();

  // ── 程序化枪声 + 准星脉冲（每次射击都触发）─────
  playGunSound('shoot', 0.25);
  triggerCrosshairPulse();

  // ── 命中反馈 ─────────────────────────────────
  if (result.hit && result.point) {
    const targetType = result.target?.type || 'normal';

    if (result.comboDestroyed) {
      playGunSound('downbeat', 0.45);
      effectManager.spawnHitEffect(result.point, 'charge');
      triggerScreenShake(0.06);
      targetManager.flashTargetOnHit(result.target, 'Perfect');
    } else if (result.comboHit) {
      playGunSound('perfect', 0.25);
      effectManager.spawnHitEffect(result.point, 'combo');
      targetManager.flashTargetOnHit(result.target, 'Perfect');
      showComboHp(result.comboRemaining, result.target?.maxHitPoints || 0);
    } else {
      // 普通靶子：靶子闪烁 + 判定音效
      targetManager.flashTargetOnHit(result.target, result.judgment);

      if (result.judgment === 'Perfect') {
        playGunSound('perfect', 0.32);
        effectManager.spawnHitEffect(result.point, targetType);
        triggerCrosshairPulse();
        if (targetType === 'downbeat') {
          playGunSound('downbeat', 0.35);
          triggerScreenShake(0.04);
        } else {
          triggerScreenShake(0.015);
        }
      } else if (result.judgment === 'Good') {
        playGunSound('perfect', 0.22);
        effectManager.spawnHitEffect(result.point, targetType);
        if (targetType === 'downbeat') {
          playGunSound('downbeat', 0.28);
          triggerScreenShake(0.025);
        }
      } else {
        // Miss on hit (bad timing but hit the target)
        playGunSound('miss', 0.20);
      }
    }
  } else {
    // 空枪 → 闷响
    playGunSound('miss', 0.18);
  }

  const state = getScoreState();
  const comboNote = result.comboHit
    ? `comboHit  rem=${result.comboRemaining}`
    : result.comboDestroyed
      ? 'comboDESTROYED'
      : '';
  console.log(
    `[Shoot] time=${songTime.toFixed(3)}s  beat=#${beatIndex}(@${beatTime.toFixed(3)}s)  ` +
    `err=${(error * 1000).toFixed(1)}ms  →  ${result.judgment}  ` +
    `(hit=${result.hit})  ${comboNote}  |  score=${state.score}  combo=${state.combo}`
  );
});

// ═══ 9. R 键重置 ════════════════════════════════
window.addEventListener('player-reset', () => {
  resetScore();
  if (chart) {
    targetManager.setChart(chart);
  } else {
    targetManager.clear();
  }
  console.log('[Game] Reset.');
});

// ═══ 谱面保存/载入 ───────────────────────

const STORAGE_KEY = 'bossrush_custom_charts';
function _saveCustomChart(name) {
  if (!name || _editor.targets.length === 0) { _editorShowStatus('Need name + targets.', '#ff8800'); return; }
  const entry = { name, songFile: _editor.songFile, bpm: _editor.songBpm, offset: _editor.songOffset, duration: _editor.songDuration, targets: _editor.targets, createdAt: new Date().toISOString() };
  let charts = []; try { charts = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (_) {}
  charts.push(entry); localStorage.setItem(STORAGE_KEY, JSON.stringify(charts));
  _refreshChartSelect(); _editorShowStatus(`Saved "${name}".`, '#44ff88');
}
function _loadCustomCharts() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (_) { return []; } }
function _refreshChartSelect() {
  const sel = document.getElementById('chart-select'); if (!sel) return;
  const charts = _loadCustomCharts(); sel.innerHTML = '<option value="auto">Auto Generated</option>';
  charts.forEach((c, i) => { const o = document.createElement('option'); o.value = 'custom_' + i; o.textContent = c.name + ' (' + c.targets.length + ' targets)'; sel.appendChild(o); });
}
function _getChartBySelect(v) { if (!v || v === 'auto') return null; const i = parseInt(v.replace('custom_', '')); return _loadCustomCharts()[i] || null; }

// ── 靶子类型注册表（颜色 + 标签，可扩展）─────
const TYPE_REGISTRY = {
  normal:   { color: '#00ffff', label: 'Normal' },
  downbeat: { color: '#ff00ff', label: 'Downbeat' },
  charge:   { color: '#ffff00', label: 'Charge' },
  combo:    { color: '#ff8800', label: 'Combo' },
  slide:    { color: '#44ff88', label: 'Slide' },
};
let _editorPlaceType = 'normal';
let _editorMode = 'A'; // 'A' = beat grid, 'B' = free
let _editorDragIdx = -1;
let _editorDragStartX = 0;

// ── 时间轴绘制（增强：色条束 + 拖动悬停）─────
function _drawTimeline() {
  const c = document.getElementById('editor-timeline'); if (!c || _editor.songDuration <= 0) return;
  const ctx = c.getContext('2d'), W = c.width, H = c.height; ctx.clearRect(0, 0, W, H);
  const dur = _editor.songDuration, cur = _editor.playback !== 'idle' ? getSongTime() : 0;

  if (_editorMode === 'A') {
    const bi = 60 / _editor.songBpm;
    // 强拍线
    for (let t = 0; t < dur; t += bi) {
      const x = (t / dur) * W;
      const isDown = Math.round(t / bi) % 4 === 0;
      ctx.strokeStyle = isDown ? 'rgba(0,255,255,0.2)' : 'rgba(0,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    // Mode A 小节范围高亮
    const ms = parseInt(document.getElementById('editor-ma-start')?.value) || 1;
    const me = parseInt(document.getElementById('editor-ma-end')?.value) || 4;
    const biSec = 60 / _editor.songBpm;
    const sX = (ms - 1) * 4 * biSec / dur * W;
    const eX = me * 4 * biSec / dur * W;
    ctx.fillStyle = 'rgba(0,255,255,0.06)';
    ctx.fillRect(sX, 0, eX - sX, H);
  }

  // 色条束（靶子标记，宽 6px）
  for (let i = 0; i < _editor.targets.length; i++) {
    const t = _editor.targets[i];
    const x = (t.time / dur) * W;
    const cfg = TYPE_REGISTRY[t.type] || TYPE_REGISTRY.normal;
    ctx.fillStyle = cfg.color;
    ctx.fillRect(x - 3, H / 2 - 10, 6, 20);
    ctx.fillStyle = '#ffffff';
    ctx.font = '9px monospace';
    ctx.fillText(t.type[0].toUpperCase(), x - 3, H - 4);
    if (i === _editorDragIdx) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 5, H / 2 - 12, 10, 24);
    }
  }

  // 播放头
  const px = Math.min((cur / dur) * W, W);
  ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
}

// ── 时间轴交互：点击添加 / 拖动调整 ──────────
const _timeline = document.getElementById('editor-timeline');
_timeline?.addEventListener('mousedown', (e) => {
  if (_editor.songDuration <= 0) return;
  const r = e.target.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const t = (mx / r.width) * _editor.songDuration;

  // 检查是否点中已有靶子（拖动）
  const hitIdx = _editor.targets.findIndex(tg => Math.abs((tg.time / _editor.songDuration) * r.width - mx) < 8);
  if (hitIdx >= 0) {
    _editorDragIdx = hitIdx;
    _editorDragStartX = mx;
    e.preventDefault();
  } else {
    // 添加新靶子
    let time = t;
    if (_editorMode === 'A') {
      const bi = 60 / _editor.songBpm;
      time = Math.round(t / bi) * bi; // snap to beat
    }
    time = Math.round(time * 1000) / 1000;
    _editor.targets.push({ time, type: _editorPlaceType, position: [0, 1.6, -6] });
    _editor.targets.sort((a, b) => a.time - b.time);
    _editorUpdateCount(); _drawTimeline();
  }
});

window.addEventListener('mousemove', (e) => {
  if (_editorDragIdx < 0 || _editor.songDuration <= 0) return;
  const r = _timeline?.getBoundingClientRect(); if (!r) return;
  const mx = e.clientX - r.left;
  let t = Math.max(0, Math.min(_editor.songDuration, (mx / r.width) * _editor.songDuration));
  if (_editorMode === 'A') {
    const bi = 60 / _editor.songBpm;
    t = Math.round(t / bi) * bi;
  }
  t = Math.round(t * 1000) / 1000;
  _editor.targets[_editorDragIdx].time = t;
  _drawTimeline();
  const el = document.getElementById('editor-status');
  if (el) el.textContent = `Dragging: ${t.toFixed(3)}s (${_editor.targets[_editorDragIdx].type})`;
});

window.addEventListener('mouseup', () => {
  if (_editorDragIdx >= 0) {
    _editor.targets.sort((a, b) => a.time - b.time);
    _editorDragIdx = -1;
    _editorUpdateCount(); _drawTimeline();
  }
});

// ── Mode 切换 ──────────────────────────────
document.getElementById('editor-mode-a')?.addEventListener('click', () => {
  _editorMode = 'A';
  document.getElementById('editor-mode-a').className = 'menu-btn';
  document.getElementById('editor-mode-b').className = 'menu-btn secondary';
  document.getElementById('editor-mode-label').textContent = 'Mode A: snap to beat';
  document.getElementById('editor-modea-opts').style.display = '';
  _drawTimeline();
});
document.getElementById('editor-mode-b')?.addEventListener('click', () => {
  _editorMode = 'B';
  document.getElementById('editor-mode-b').className = 'menu-btn';
  document.getElementById('editor-mode-a').className = 'menu-btn secondary';
  document.getElementById('editor-mode-label').textContent = 'Mode B: free placement';
  document.getElementById('editor-modea-opts').style.display = 'none';
  _drawTimeline();
});

// Mode A 小节范围更新
['editor-ma-start', 'editor-ma-end'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => {
    const ms = parseInt(document.getElementById('editor-ma-start')?.value) || 1;
    const me = parseInt(document.getElementById('editor-ma-end')?.value) || 4;
    const bi = 60 / _editor.songBpm;
    const el = document.getElementById('editor-ma-range-time');
    if (el) el.textContent = `${((ms - 1) * 4 * bi).toFixed(1)}s – ${(me * 4 * bi).toFixed(1)}s`;
    _drawTimeline();
  });
});

// ── 靶子类型按钮（从 TYPE_REGISTRY 生成）─────
const _tlTypeRow = document.querySelector('#editor-screen .editor-row');
Object.entries(TYPE_REGISTRY).forEach(([key, cfg]) => {
  const btn = document.createElement('button');
  btn.textContent = cfg.label;
  btn.className = 'menu-btn secondary';
  btn.style.cssText = 'min-width:auto;padding:4px 10px;font-size:12px;';
  btn.addEventListener('click', () => {
    _editorPlaceType = key;
    document.getElementById('editor-tl-type').textContent = `← ${cfg.label} (${cfg.color})`;
    document.querySelectorAll('#editor-screen .editor-row .menu-btn').forEach(b => b.classList.add('secondary'));
    btn.classList.remove('secondary');
  });
  const row = document.querySelector('#editor-screen .editor-row');
  if (row) row.appendChild(btn);
});
document.getElementById('editor-save-btn')?.addEventListener('click', () => _saveCustomChart(document.getElementById('editor-chart-name')?.value.trim()));
document.getElementById('editor-load-list-btn')?.addEventListener('click', () => {
  const sel = document.getElementById('editor-load-select'); if (!sel) return;
  const charts = _loadCustomCharts(); sel.style.display = charts.length ? '' : 'none'; sel.innerHTML = '';
  charts.forEach((c, i) => { const o = document.createElement('option'); o.value = 'custom_' + i; o.textContent = c.name; sel.appendChild(o); });
});
document.getElementById('editor-load-select')?.addEventListener('change', (e) => {
  const ch = _getChartBySelect(e.target.value); if (!ch) return;
  _editor.targets = ch.targets; _editor.songBpm = ch.bpm; _editor.songOffset = ch.offset;
  document.getElementById('editor-bpm').value = ch.bpm; document.getElementById('editor-offset').value = ch.offset;
  document.getElementById('editor-chart-name').value = ch.name; _editorUpdateCount(); _drawTimeline();
  _editorShowStatus(`Loaded "${ch.name}".`, '#44ff88');
});
_refreshChartSelect();

// ═══ 10. Slide 空格输入 ─────────────────────

let _spaceHeld = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && getMenuState() === 'playing') {
    e.preventDefault();
    _spaceHeld = true;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    _spaceHeld = false;
  }
});

// ═══ 11. 环境粒子系统 ════════════════════════

const _ambientParticles = (() => {
  const COUNT = 60;
  const positions = new Float32Array(COUNT * 3);
  const _data = []; // { vx, vy, baseSize, phase }

  for (let i = 0; i < COUNT; i++) {
    positions[i * 3]     = (Math.random() - 0.5) * 30;  // x: ±15
    positions[i * 3 + 1] = Math.random() * 5 + 0.5;      // y: 0.5-5.5
    positions[i * 3 + 2] = -(Math.random() * 12 + 4);    // z: -4 to -16
    _data.push({
      vx: (Math.random() - 0.5) * 1.2,
      vy: (Math.random() - 0.5) * 0.3,
      baseSize: Math.random() * 0.04 + 0.02,
      phase: Math.random() * Math.PI * 2,
    });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x4488cc,
    size: 0.06,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.renderOrder = -1;
  points.raycast = () => {};
  scn.add(points);

  return { points, data: _data, positions, mat, geo };
})();

function _updateAmbientParticles(delta, songTime, beatJustHappened, isDownbeat) {
  const p = _ambientParticles;
  const arr = p.positions;

  for (let i = 0; i < p.data.length; i++) {
    const d = p.data[i];
    const idx = i * 3;

    arr[idx]     += d.vx * delta;
    arr[idx + 1] += d.vy * delta + Math.sin(songTime * 2 + d.phase) * 0.15 * delta;

    if (arr[idx] > 15) arr[idx] = -15;
    if (arr[idx] < -15) arr[idx] = 15;
    if (arr[idx + 1] > 5.5) arr[idx + 1] = 0.5;
    if (arr[idx + 1] < 0.5) arr[idx + 1] = 5.5;
  }

  p.geo.attributes.position.needsUpdate = true;

  // 鼓点脉冲
  if (beatJustHappened) {
    const boost = isDownbeat ? 1.8 : 1.3;
    const dur = isDownbeat ? 0.20 : 0.10;
    // 速度脉冲
    for (const d of p.data) {
      d.vx *= boost;
      d.vy *= boost;
    }
    // 亮度脉冲
    p.mat.opacity = isDownbeat ? 0.55 : 0.40;
    setTimeout(() => {
      p.mat.opacity = 0.35;
      for (const d of p.data) { d.vx /= boost; d.vy /= boost; }
    }, dur * 1000);
  }
}

// ═══ 11. 激光模式 ══════════════════════════

/** 激光状态机 */
const laser = {
  heat: 0,
  maxHeat: 100,
  isActive: false,
  isOverheated: false,
  beam: null,
  glow: null,
  lastTickTime: 0,
  tickInterval: 0.08,
  cooldownRate: 28,
  heatRate: 22,
  hitTarget: null,
  hitPoint: null,
  _raycaster: new THREE.Raycaster(),
  // 波动 + 淡入淡出
  _fadeAlpha: 0,
  _particles: [],
  _hitRing: null,
  _hitRingAge: 0,
};

(function _createLaserBeams() {
  // ── 核心光束（亮蓝细柱）─────────────────────
  const coreGeo = new THREE.CylinderGeometry(0.015, 0.045, 1, 16, 1, true);
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0x2266ff,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  laser.beam = new THREE.Mesh(coreGeo, coreMat);
  laser.beam.visible = false;
  laser.beam.renderOrder = 2;
  scn.add(laser.beam);

  // ── 中层光晕 ─────────────────────────────────
  const midGeo = new THREE.CylinderGeometry(0.05, 0.12, 1, 16, 1, true);
  const midMat = new THREE.MeshBasicMaterial({
    color: 0x4488ff,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  laser._midGlow = new THREE.Mesh(midGeo, midMat);
  laser._midGlow.visible = false;
  laser._midGlow.renderOrder = 1;
  scn.add(laser._midGlow);

  // ── 外层光晕 ─────────────────────────────────
  const outerGeo = new THREE.CylinderGeometry(0.12, 0.28, 1, 16, 1, true);
  const outerMat = new THREE.MeshBasicMaterial({
    color: 0x66aaff,
    transparent: true,
    opacity: 0.06,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  laser.glow = new THREE.Mesh(outerGeo, outerMat);
  laser.glow.visible = false;
  laser.glow.renderOrder = 0;
  scn.add(laser.glow);

  // ── 粒子流动（沿光束的小光点）───────────────
  for (let i = 0; i < 10; i++) {
    const pGeo = new THREE.SphereGeometry(0.025, 6, 6);
    const pMat = new THREE.MeshBasicMaterial({
      color: 0x88ccff,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const p = new THREE.Mesh(pGeo, pMat);
    p.visible = false;
    p.renderOrder = 3;
    p.userData = { t: i / 10, speed: 0.8 + Math.random() * 1.2 };
    scn.add(p);
    laser._particles.push(p);
  }
})();

function _hideAllLaserParts() {
  laser.beam.visible = false;
  laser._midGlow.visible = false;
  laser.glow.visible = false;
  for (const p of laser._particles) p.visible = false;
  if (laser._hitRing) {
    scn.remove(laser._hitRing);
    laser._hitRing.geometry.dispose();
    laser._hitRing.material.dispose();
    laser._hitRing = null;
  }
}

function _updateLaserBeam() {
  laser._raycaster.setFromCamera(new THREE.Vector2(0, 0), cam);
  const intersects = laser._raycaster.intersectObjects(
    targetManager.getTargetMeshes(), true
  );

  let hitDist = 25;
  laser.hitTarget = null;
  laser.hitPoint = null;
  let beamColor = 0x2266ff;
  let glowColor = 0x66aaff;

  if (intersects.length > 0) {
    const t = targetManager.getTargetByMesh(intersects[0].object);
    if (t && !t.isHit) {
      hitDist = intersects[0].distance;
      laser.hitTarget = t;
      laser.hitPoint = intersects[0].point.clone();
      const colorMap = {
        normal: 0x00ffff, downbeat: 0xff00ff, charge: 0xffff00,
        combo: 0xff8800, slide: 0x44ff88,
      };
      beamColor = colorMap[t.type] || 0x2266ff;
      glowColor = beamColor;
    }
  }

  // 所有光束部件着色
  laser.beam.material.color.set(beamColor);
  laser._midGlow.material.color.set(glowColor);
  laser.glow.material.color.set(glowColor);

  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const center = cam.position.clone().add(dir.clone().multiplyScalar(hitDist / 2));

  // ── 波动脉冲 ────────────────────────────────
  const t = getSongTime();
  const wave1 = 1 + 0.06 * Math.sin(t * 15);
  const wave2 = 1 + 0.10 * Math.sin(t * 11 + 1.2);

  function placeBeam(mesh, scaleXZ) {
    mesh.position.copy(center);
    mesh.scale.set(scaleXZ, hitDist, scaleXZ);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  }

  placeBeam(laser.beam, wave1);
  placeBeam(laser._midGlow, wave2);
  placeBeam(laser.glow, 1);

  // ── 流动粒子 ────────────────────────────────
  const beamStart = cam.position.clone();
  for (const p of laser._particles) {
    p.userData.t += laser.tickInterval * p.userData.speed;
    if (p.userData.t > 1) p.userData.t -= 1;
    const pt = beamStart.clone().add(dir.clone().multiplyScalar(hitDist * p.userData.t));
    p.position.copy(pt);
    p.material.color.set(0x88ccff);
    p.material.opacity = 0.3 + 0.5 * (1 - p.userData.t); // 越远越暗
    p.visible = true;
  }

  // ── 命中闪光环 ──────────────────────────────
  if (laser.hitPoint && !laser._hitRing) {
    const ringGeo = new THREE.TorusGeometry(0.15, 0.04, 16, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: beamColor,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    laser._hitRing = new THREE.Mesh(ringGeo, ringMat);
    laser._hitRing.position.copy(laser.hitPoint);
    laser._hitRing.lookAt(cam.position);
    laser._hitRing.userData = { age: 0 };
    scn.add(laser._hitRing);
  }
  if (laser._hitRing) {
    laser._hitRing.userData.age += 0.016;
    const age = laser._hitRing.userData.age;
    const s = 1 + age * 6;
    laser._hitRing.scale.setScalar(s);
    laser._hitRing.material.opacity = Math.max(0, 0.9 - age * 2);
    if (laser._hitRing.material.opacity <= 0) {
      scn.remove(laser._hitRing);
      laser._hitRing.geometry.dispose();
      laser._hitRing.material.dispose();
      laser._hitRing = null;
    }
  }
}

function _processLaserTick(songTime) {
  if (!laser.hitTarget) return;

  const t = laser.hitTarget;
  const beatInfo = getNearestBeatInfo(songTime);
  const onBeat = Math.abs(beatInfo.error) <= 0.05;

  // slide 靶子由空格键处理，激光不做任何事
  if (t.type === 'slide') return;

  // combo 靶子：每 3 tick 扣 1 HP
  if (t.type === 'combo' && t.hitPoints > 0) {
    if (!t._laserTickCount) t._laserTickCount = 0;
    t._laserTickCount++;
    if (t._laserTickCount >= 3) {
      t._laserTickCount = 0;
      const { destroyed } = targetManager.hitComboTarget(t, songTime);
      if (destroyed) {
        targetManager.removeTarget(t);
        applyComboDestroy();
        effectManager.spawnHitEffect(laser.hitPoint, 'charge');
        triggerScreenShake(0.015);
        laser.hitTarget = null;
        return;
      }
      applyComboHit();
    }
  }

  // 持续命中 tick 计分
  applyLaserTick(onBeat);

  // 命中火花
  effectManager.spawnLaserSpark(laser.hitPoint, laser.beam.material.color.getHex());

  // 靶子闪烁
  if (t.mesh && t.mesh.children && t.mesh.children[0]) {
    const sphere = t.mesh.children[0];
    if (sphere.material && sphere.material.emissive) {
      const orig = sphere.material.emissive.getHex();
      sphere.material.emissive.set(0xffffff);
      setTimeout(() => {
        if (sphere.material) sphere.material.emissive.set(orig);
      }, 50);
    }
  }
}

// ═══ 11. 动画循环 ═══════════════════════════════

// debug overlay 元素
const debugEl = document.getElementById('debug-overlay');

// 节拍环状态
let lastBeatIndex = -1;

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();

  // ---- 第一人称视角（仅 playing 状态）----
  if (getMenuState() === 'playing') updateCamera();

  // ---- 靶子系统（仅 playing 状态）---------
  const songTime = getSongTime();
  if (getMenuState() === 'playing') {
    targetManager.update(songTime);
  }

  // ---- Slide 空格处理（独立于左键靶子）────
  if (getMenuState() === 'playing') {
    const slide = targetManager.getCurrentSlideTarget();
    if (slide) {
      if (_spaceHeld) {
        targetManager.trackSlideTarget(slide, delta);
        if (songTime - (slide._lastSlideTick || 0) >= 0.08) {
          slide._lastSlideTick = songTime;
          const beatInfo = getNearestBeatInfo(songTime);
          applySlideTick(Math.abs(beatInfo.error) <= 0.05);
          showSlideCharge(slide.totalCharge);
        }
      } else {
        targetManager.drainSlideTarget(slide, delta);
      }
    }
  }

  // ---- 激光模式（仅 playing 状态）─────────
  if (getMenuState() === 'playing') {
  const rightDown = isRightMouseDown();
  if (rightDown && !laser.isOverheated && document.pointerLockElement) {
    if (!laser.isActive) {
      laser.isActive = true;
      laser.beam.visible = true;
      laser._midGlow.visible = true;
      laser.glow.visible = true;
      for (const p of laser._particles) p.visible = true;
      startLaserHum();
    }
    // 淡入
    laser._fadeAlpha = Math.min(1, laser._fadeAlpha + delta * 4);
    laser.heat = Math.min(laser.maxHeat, laser.heat + delta * laser.heatRate);
    if (laser.heat >= laser.maxHeat) {
      laser.isOverheated = true;
      laser.isActive = false;
      _hideAllLaserParts();
      stopLaserHum();
      triggerScreenShake(0.04);
    }
  } else {
    if (laser.isActive) {
      laser.isActive = false;
      _hideAllLaserParts();
      stopLaserHum();
    }
    // 淡出
    laser._fadeAlpha = Math.max(0, laser._fadeAlpha - delta * 5);
    laser.heat = Math.max(0, laser.heat - delta * laser.cooldownRate);
    if (laser.heat <= 0) laser.isOverheated = false;
  }

  // 应用淡入淡出透明度
  const fa = laser._fadeAlpha;
  if (fa > 0.001) {
    laser.beam.visible = true;
    laser._midGlow.visible = true;
    laser.glow.visible = true;
    laser.beam.material.opacity = 0.7 * fa;
    laser._midGlow.material.opacity = 0.22 * fa;
    laser.glow.material.opacity = 0.06 * fa;
    for (const p of laser._particles) {
      p.visible = true;
      p.material.opacity *= fa;
    }
  } else if (!laser.isActive) {
    laser.beam.visible = false;
    laser._midGlow.visible = false;
    laser.glow.visible = false;
    for (const p of laser._particles) p.visible = false;
    // 清理命中环
    if (laser._hitRing) {
      scn.remove(laser._hitRing);
      laser._hitRing.geometry.dispose();
      laser._hitRing.material.dispose();
      laser._hitRing = null;
    }
  }

  // 屏幕边缘激光着色
  if (fa > 0.01) {
    const pulse = 0.03 + 0.02 * Math.sin(getSongTime() * 5);
    document.getElementById('game-container').style.boxShadow =
      `inset 0 0 100px rgba(34,102,255,${(pulse * fa).toFixed(3)})`;
  } else {
    document.getElementById('game-container').style.boxShadow = '';
  }

  if (laser.isActive) {
    _updateLaserBeam();
    if (songTime - laser.lastTickTime >= laser.tickInterval) {
      laser.lastTickTime = songTime;
      _processLaserTick(songTime);
    }
  } else {
    // 激光关闭时无特殊处理
  }

  updateHeatBar(laser.heat);
  } // end playing guard

  // ---- 节拍进度计算 ----
  const beatDur = 60 / chartBpm;
  const adjustedTime = songTime - effectiveOffset;
  const exactBeat = adjustedTime / beatDur;
  const beatIndex = Math.floor(exactBeat);
  const progress = exactBeat - beatIndex;        // 0→1 within current beat
  const isDownbeat = beatIndex % 4 === 0;
  const beatJustHappened = beatIndex !== lastBeatIndex;

  // 高潮段检测 + 外环颜色切换 + 动感光效
  const measureIdx = Math.floor(exactBeat / 4);
  const sectionNow = measureIdx >= 0 ? getChartSection(measureIdx) : 'intro';
  const isClimax = sectionNow === 'drop';
  const wasClimax = _climaxActive;

  if (isClimax && !wasClimax) {
    // 进入高潮 → 切换外环为高潮色 + 启用光效
    setRingColor(0xff4488); // 品红高潮色
    _climaxActive = true;
    console.log('[Climax] ENTERED — ring color set to climax, glow active.');
  } else if (!isClimax && wasClimax) {
    // 离开高潮 → 恢复默认色 + 关闭光效
    setRingColor(0x00ffff); // 青色默认
    _climaxActive = false;
    scn.background = new THREE.Color(0x000000);
    document.getElementById('game-container').style.boxShadow = '';
    console.log('[Climax] EXITED — ring color restored, glow off.');
  }

  // 高潮持续光效（subtle，不影响瞄准）
  if (_climaxActive) {
    const glowPulse = 0.02 + 0.01 * Math.sin(songTime * 3);
    scn.background = new THREE.Color(glowPulse * 0.8, glowPulse * 0.1, glowPulse * 0.3);
    document.getElementById('game-container').style.boxShadow =
      `inset 0 0 60px rgba(255,68,136,${(0.04 + 0.02 * Math.sin(songTime * 2.5)).toFixed(3)})`;
  }

  if (beatJustHappened) {
    lastBeatIndex = beatIndex;

    // 场景律动：downbeat 时 FOV 脉动 + 背景微闪
    if (getMenuState() === 'playing') {
      const baseFov = 75;
      const pulseAmp = isDownbeat ? 0.8 : 0.25;
      cam.fov = baseFov + pulseAmp;
      requestAnimationFrame(() => {
        cam.fov += (baseFov - cam.fov) * 0.3;
        cam.updateProjectionMatrix();
      });
      cam.updateProjectionMatrix();

      const flash = isDownbeat ? 0.03 : 0.01;
      scn.background = new THREE.Color(
        0.02 * flash, 0.01 * flash, 0.04 * flash
      );
      setTimeout(() => {
        scn.background = new THREE.Color(0x000000);
      }, isDownbeat ? 80 : 40);

      // 网格起伏：呼吸感 Y 位移 + 透明度脉冲
      const grid = getGridGroup();
      if (grid) {
        const waveY = isDownbeat ? 0.06 : 0.02;
        grid.position.y = waveY;
        // 渐回原位
        setTimeout(() => { grid.position.y *= 0.5; }, 60);

        // 网格线闪亮
        const boost = isDownbeat ? 0.08 : 0.03;
        grid.children.forEach((child, i) => {
          if (child.material && child.material.opacity !== undefined) {
            const base = i === 0 ? 0 : (i === 1 ? 0.06 : 0.12); // plane=0, sub=0.06, main=0.12
            child.material.opacity = Math.min(1, base + boost);
            setTimeout(() => {
              if (child.material) child.material.opacity = base;
            }, isDownbeat ? 120 : 60);
          }
        });
      }
    }
  }

  // ---- 节拍环 + 指示器（仅 playing）--------
  if (getMenuState() === 'playing') {
    updateBeatRing(progress, isDownbeat, beatJustHappened);
    const onBeat = progress < 0.12;
    updateBeatIndicator(progress, onBeat);
  }

  // ---- 特效更新（始终运行，渐出效果）-------
  effectManager.update(delta);

  // ---- 环境粒子 ----
  _updateAmbientParticles(delta, songTime, beatJustHappened, isDownbeat);

  // ---- 编辑器时间显示更新 ----
  if (getMenuState() === 'editor' && _editor.playback !== 'idle') {
    _editorUpdateTimeDisplay();
  }

  // ---- Debug overlay ----
  if (debugEl) {
    const locked = document.pointerLockElement === rnd.domElement;
    debugEl.textContent =
      `rendererReady: ${!!rnd}\n` +
      `pointerLocked: ${locked}\n` +
      `menuState: ${getMenuState()}\n` +
      `gameStarted: ${audioStarted}\n` +
      `cam pos: (${cam.position.x.toFixed(1)}, ${cam.position.y.toFixed(1)}, ${cam.position.z.toFixed(1)})\n` +
      `cam rot: y=${cam.rotation.y.toFixed(2)} x=${cam.rotation.x.toFixed(2)}\n` +
      `scene.children: ${scn.children.length}\n` +
      `chartLoaded: ${!!chart}\n` +
      `targets.active: ${targetManager.targets.length}\n` +
      `songTime: ${songTime.toFixed(2)}s`;
  }

  // ---- 谱面完成兜底检测 ----
  checkChartComplete();

  // ---- 渲染 ----
  render();
}

animate();

console.log('BossRush ready. Click START to begin.');
