/**
 * scoring.js — 节拍判定 & 计分模块
 *
 * 基于音乐播放时间 (songTime) 做节拍窗口判定，
 * 不依赖 Date.now()。
 *
 * 用法：
 *   import { setTimingConfig, judgeTiming, applyJudgment, getScoreState } from './scoring.js';
 *   setTimingConfig({ bpm: 130, perfectWindow: 0.05, goodWindow: 0.12 });
 *   const result = judgeTiming(getSongTime());
 *   applyJudgment(result);
 *
 * 导出：
 *   setTimingConfig(config)
 *   getNearestBeatInfo(songTime)
 *   judgeTiming(songTime)
 *   applyJudgment(judgment)
 *   resetScore()
 *   getScoreState()
 */

import { updateScore, updateCombo, showJudgment } from './ui.js';

// ═══════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════

/**
 * @typedef {Object} TimingConfig
 * @property {number} bpm           - 每分钟节拍数，默认 120
 * @property {number} offset        - 全局时间偏移 (秒)，默认 0
 * @property {number} perfectWindow - Perfect 判定窗口 (秒)，默认 0.05
 * @property {number} goodWindow    - Good 判定窗口 (秒)，默认 0.12
 */

/** @type {TimingConfig} */
const timingConfig = {
  bpm: 120,
  offset: 0,
  perfectWindow: 0.05,   // ±50ms
  goodWindow: 0.12,      // ±120ms
};

// ═══════════════════════════════════════════════════
// 计分状态
// ═══════════════════════════════════════════════════

let score = 0;
let combo = 0;
let maxCombo = 0;

const stats = {
  perfect: 0,
  good: 0,
  miss: 0,
  totalShots: 0,
};

// ═══════════════════════════════════════════════════
// 内部
// ═══════════════════════════════════════════════════

/** 当前节拍时长 (秒) */
function beatDuration() {
  return 60 / timingConfig.bpm;
}

// ═══════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════

/**
 * 设置节拍判定配置
 *
 * @param {Partial<TimingConfig>} config
 *
 * 示例：
 *   setTimingConfig({ bpm: 140, perfectWindow: 0.04 });
 */
export function setTimingConfig(config) {
  if (config.bpm !== undefined)          timingConfig.bpm = config.bpm;
  if (config.offset !== undefined)       timingConfig.offset = config.offset;
  if (config.perfectWindow !== undefined) timingConfig.perfectWindow = config.perfectWindow;
  if (config.goodWindow !== undefined)    timingConfig.goodWindow = config.goodWindow;

  console.log(
    `[Scoring] Config: BPM=${timingConfig.bpm}  offset=${timingConfig.offset}s  ` +
    `perfect=±${(timingConfig.perfectWindow * 1000).toFixed(0)}ms  ` +
    `good=±${(timingConfig.goodWindow * 1000).toFixed(0)}ms`
  );
}

/**
 * 根据音乐时间计算最近的节拍信息
 *
 * 判定完全基于 songTime（AudioContext.currentTime），
 * 不依赖 Date.now() 或 performance.now()。
 *
 * @param {number} songTime — 当前音乐播放时间 (秒)，来自 audio.getSongTime()
 * @returns {{ beatIndex: number, beatTime: number, error: number }}
 *   - beatIndex  节拍序号
 *   - beatTime   该节拍对应的绝对音乐时间 (秒)
 *   - error      误差 = songTime - beatTime
 *                正值 = 打晚了  负值 = 打早了
 */
export function getNearestBeatInfo(songTime) {
  const dur = beatDuration();
  const adjustedTime = songTime - timingConfig.offset;

  // 最近的节拍索引
  const beatIndex = Math.round(adjustedTime / dur);

  // 该节拍对应的音乐时间
  const beatTime = beatIndex * dur + timingConfig.offset;

  // 带符号的误差（正 = 晚，负 = 早）
  const error = songTime - beatTime;

  return { beatIndex, beatTime, error };
}

/**
 * 根据音乐时间判定精度等级
 *
 * @param {number} songTime — 当前音乐播放时间 (秒)
 * @returns {'Perfect' | 'Good' | 'Miss'}
 */
export function judgeTiming(songTime) {
  stats.totalShots++;

  const { error, beatIndex } = getNearestBeatInfo(songTime);
  const absError = Math.abs(error);

  if (absError <= timingConfig.perfectWindow) {
    return 'Perfect';
  }

  if (absError <= timingConfig.goodWindow) {
    return 'Good';
  }

  return 'Miss';
}

/**
 * 基于 target.hitTime 直接判定（不依赖节拍网格）
 * 命中误差 = songTime - hitTime，正值=打晚，负值=打早
 *
 * @param {number} songTime
 * @param {number} hitTime  — 靶子的 hitTime
 * @returns {'Perfect' | 'Good' | 'Miss'}
 */
export function judgeHit(songTime, hitTime) {
  stats.totalShots++;
  const error = Math.abs(songTime - hitTime);

  if (error <= timingConfig.perfectWindow) return 'Perfect';
  if (error <= timingConfig.goodWindow)    return 'Good';
  return 'Miss';
}

/**
 * 应用判定结果，更新分数、combo 和 UI
 *
 * 计分规则：
 *   Perfect → +300, combo +1
 *   Good    → +100, combo +1
 *   Miss    → +0,   combo 清零
 *
 * @param {'Perfect' | 'Good' | 'Miss'} judgment
 */
export function applyJudgment(judgment) {
  switch (judgment) {
    case 'Perfect':
      combo += 1;
      score += 300;
      stats.perfect++;
      break;
    case 'Good':
      combo += 1;
      score += 100;
      stats.good++;
      break;
    case 'Miss':
      combo = 0;
      stats.miss++;
      break;
    default:
      return;
  }

  if (combo > maxCombo) maxCombo = combo;

  // ── 更新 UI ────────────────────────────────
  updateScore(score);
  updateCombo(combo);
  showJudgment(judgment);
}

/**
 * combo 靶子单次命中计分
 *
 * 每次命中 +50，combo +1（不参与 accuracy 计算以免拉低评级）
 */
export function applyComboHit() {
  combo += 1;
  score += 50;
  stats.totalShots++;

  if (combo > maxCombo) maxCombo = combo;

  updateScore(score);
  updateCombo(combo);
  showJudgment('Perfect');
}

/**
 * combo 靶子击破奖励
 *
 * 最后一击额外 +100，判定文字显示 "COMBO!"
 */
/**
 * combo 靶子击破奖励（最后一击）
 * +150 = 50 (命中) + 100 (击破奖励)
 */
export function applyComboDestroy() {
  combo += 1;
  score += 150;
  stats.totalShots++;

  if (combo > maxCombo) maxCombo = combo;

  updateScore(score);
  updateCombo(combo);
  showJudgment('Perfect');
}

/**
 * combo 靶子部分失败（超时未打完）
 *
 * 已命中的分数保留，无额外惩罚。
 * 判定文字显示 "COMBO FAIL"
 *
 * @param {number} hitsLanded - 实际命中次数
 */
/**
 * combo 靶子部分失败 — 只重置 combo，不重复计 Miss
 * （已命中的分数保留）
 */
export function applyComboPartial(hitsLanded) {
  combo = 0;
  updateCombo(combo);
  showJudgment('Miss');
  // 不计 stats.miss — 玩家至少命中了一部分
  console.log(`[Scoring] Combo partial: ${hitsLanded} hit(s) landed, combo reset.`);
}

/**
 * trap 靶命中 — 不计分、不计 combo、显示 "Trap!"
 */
export function applyTrapHit() {
  combo = 0;
  stats.totalShots++;
  updateScore(score);
  updateCombo(combo);
  showJudgment('Miss'); // 复用 Miss 显示，颜色用 trap
}

/**
 * 激光模式持续命中 tick 计分
 * @param {boolean} onBeat - 是否在节拍窗口内
 */
export function applyLaserTick(onBeat) {
  score += onBeat ? 10 : 3;
  updateScore(score);
}

/**
 * slide 靶子空格按住 tick 计分
 * 节拍内按住得分更高
 */
export function applySlideTick(onBeat) {
  score += onBeat ? 8 : 3;
  updateScore(score);
}

/**
 * slide 靶子按住成功奖励
 */
export function applySlideSuccess(charge) {
  score += 200;
  combo += 1;
  stats.perfect++;
  stats.totalShots++;
  if (combo > maxCombo) maxCombo = combo;
  updateScore(score);
  updateCombo(combo);
  showJudgment('Perfect');
  console.log(`[Scoring] Slide SUCCESS — charge=${(charge * 100).toFixed(0)}%`);
}

/**
 * slide 靶子按住失败（未达阈值）
 */
export function applySlideFail(charge) {
  combo = 0;
  stats.miss++;
  stats.totalShots++;
  updateCombo(combo);
  showJudgment('Miss');
  console.log(`[Scoring] Slide FAIL — charge=${(charge * 100).toFixed(0)}% < ${60}%`);
}

/**
 * 重置分数和统计
 */
export function resetScore() {
  score = 0;
  combo = 0;
  maxCombo = 0;
  stats.perfect = 0;
  stats.good = 0;
  stats.miss = 0;
  stats.totalShots = 0;

  updateScore(0);
  updateCombo(0);
}

/**
 * 获取当前计分状态
 *
 * @returns {{ score: number, combo: number, maxCombo: number, perfect: number, good: number, miss: number, totalShots: number }}
 */
export function getScoreState() {
  return {
    score,
    combo,
    maxCombo,
    perfect: stats.perfect,
    good: stats.good,
    miss: stats.miss,
    totalShots: stats.totalShots,
    accuracy: getAccuracy(),
    rank: getRank(),
  };
}

/**
 * 加权准确率
 *
 * Perfect 权重 1.0  |  Good 权重 0.5  |  Miss 权重 0
 *
 * @returns {number} 0 ~ 1
 */
export function getAccuracy() {
  const total = stats.perfect + stats.good + stats.miss;
  if (total === 0) return 0;
  return (stats.perfect * 1.0 + stats.good * 0.5) / total;
}

/**
 * 评级
 *
 *   SS ≥ 0.98  |  S ≥ 0.95  |  A ≥ 0.90  |  B ≥ 0.80  |  C 其余
 *
 * @returns {'SS' | 'S' | 'A' | 'B' | 'C'}
 */
export function getRank() {
  const acc = getAccuracy();
  if (acc >= 0.98) return 'SS';
  if (acc >= 0.95) return 'S';
  if (acc >= 0.90) return 'A';
  if (acc >= 0.80) return 'B';
  return 'C';
}
