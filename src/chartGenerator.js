/**
 * chartGenerator.js — 自动谱面生成器
 *
 * 支持三种模式：
 *   1. 纯算法 (generateAutoChart) — 仅基于 BPM/时长/难度
 *   2. 音频驱动 (generateChartFromAudio) — 基于音频分析特征
 *   3. LLM 增强 (generateChartFromAudio + useLLM) — 调用 LLM 生成指定段落
 *
 * 用法：
 *   import { generateAutoChart, generateChartFromAudio, llmGenerateMeasures } from './chartGenerator.js';
 *
 *   // 纯算法
 *   const chart = generateAutoChart({ bpm: 120, duration: 60, difficulty: 'normal' });
 *
 *   // 音频驱动
 *   const chart = generateChartFromAudio(
 *     { bpm: 120, duration: 60, difficulty: 'normal' },
 *     [{ measureIndex: 0, startTime: 0, energy: 0.3, onsetDensity: 0.2, chord: null, section: 'intro' }, ...]
 *   );
 *
 *   // LLM 增强
 *   const chart = generateChartFromAudio(
 *     { bpm: 120, duration: 60, difficulty: 'hard', useLLM: true, llmApiKey: 'sk-...' },
 *     audioFeatures
 *   );
 */

// ═══════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════

function r3(n) { return Math.round(n * 1000) / 1000; }

function mulberry32(seed) {
  let state = (seed | 0) + 0x6D2B79F5 | 0;
  state = Math.imul(state ^ state >>> 15, state | 1);
  state = state ^ Math.imul(state ^ state >>> 7, state | 61);
  return ((state ^ state >>> 14) >>> 0) / 4294967296;
}

function randRange(seed, min, max) {
  return min + mulberry32(seed) * (max - min);
}

function dist3(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const SECTION_NAMES = ['intro', 'build', 'drop', 'bridge', 'outro'];
const SECTION_THRESHOLDS = [0.12, 0.38, 0.68, 0.85];

function getSection(measureIndex, totalMeasures) {
  const r = measureIndex / Math.max(totalMeasures, 1);
  for (let i = 0; i < SECTION_THRESHOLDS.length; i++) {
    if (r < SECTION_THRESHOLDS[i]) return SECTION_NAMES[i];
  }
  return 'outro';
}

// ═══════════════════════════════════════════════════
// 难度配置
// ═══════════════════════════════════════════════════

/**
 * @typedef {Object} PositionRange
 * @property {number[]} x / y / z — [min, max]
 */

/**
 * @typedef {Object} DifficultyConfig
 * @property {number[][]}    patterns
 * @property {number}        densityBase       — 每小节基础 note 数
 * @property {number}        energyMultiplier  — 能量对密度的放大系数
 * @property {number}        sizeMultiplier
 * @property {string[]}      allowedTypes
 * @property {number}        chargeInterval
 * @property {number}        comboInterval
 * @property {number[]}      comboHitPoints
 * @property {number}        comboBurstChance
 * @property {number}        slideInterval
 * @property {number}        reactionInterval
 * @property {number}        explosionInterval
 * @property {PositionRange} downbeatPos
 * @property {PositionRange} normalPos
 * @property {PositionRange} comboPos
 * @property {PositionRange} slidePos
 * @property {number}        minDist
 */

/** @type {Object<string, DifficultyConfig>} */
const CFG = {
  easy: {
    patterns: [
      [1, 3],
      [1, 2.5, 3],
      [1, 3, 4],
    ],
    densityBase: 2,
    energyMultiplier: 0.5,
    sizeMultiplier: 1.3,
    allowedTypes: ['normal', 'downbeat'],
    trapChance: 0, // trap 已封印
    chargeInterval: 0,
    comboInterval: 0,
    comboHitPoints: [0, 0, 0, 0, 0],
    comboBurstChance: 0,
    slideInterval: 0,
    reactionInterval: 0,
    explosionInterval: 0,
    downbeatPos: { x: [-1.0, 1.0], y: [1.3, 2.0], z: [-5.5, -4.5] },
    normalPos:   { x: [-2.2, 2.2], y: [1.1, 2.4], z: [-6.5, -4.5] },
    comboPos:    { x: [-2.8, 2.8], y: [1.0, 2.2], z: [-6.5, -4.5] },
    slidePos:    { x: [-2.5, 2.5], y: [1.2, 2.2], z: [-6.5, -4.5] },
    minDist: 0.5,
  },
  normal: {
    patterns: [
      [1, 2, 3, 4],
      [1, 2, 3.5, 4],
      [1, 1.5, 2, 3, 4],
      [1, 2, 2.5, 3, 4],
    ],
    densityBase: 4,
    energyMultiplier: 1.0,
    sizeMultiplier: 1.0,
    allowedTypes: ['normal', 'downbeat', 'charge', 'combo', 'slide'],
    trapChance: 0, // trap 已封印
    chargeInterval: 8,
    comboInterval: 16,
    comboHitPoints: [3, 4, 5, 4, 3],
    comboBurstChance: 0.5,
    slideInterval: 32,
    reactionInterval: 0,
    explosionInterval: 64,
    downbeatPos: { x: [-1.8, 1.8], y: [1.2, 2.2], z: [-6, -4.5]   },
    normalPos:   { x: [-4.5, 4.5], y: [0.8, 2.8], z: [-7.5, -4.5] },
    comboPos:    { x: [-5.5, 5.5], y: [0.7, 2.6], z: [-7.5, -4.5] },
    slidePos:    { x: [-5.0, 5.0], y: [0.8, 3.0], z: [-7.5, -4.5] },
    minDist: 0.7,
  },
  hard: {
    patterns: [
      [1, 1.5, 2, 2.5, 3, 3.5, 4],
      [1, 1.25, 1.5, 2, 3, 3.5, 4],
      [1, 2, 2.5, 3, 3.25, 3.5, 4],
    ],
    densityBase: 6,
    energyMultiplier: 1.5,
    sizeMultiplier: 0.75,
    allowedTypes: ['normal', 'downbeat', 'charge', 'combo', 'slide', 'reaction', 'explosion'],
    trapChance: 0, // trap 已封印
    chargeInterval: 4,
    comboInterval: 8,
    comboHitPoints: [5, 6, 8, 6, 4],
    comboBurstChance: 0.7,
    slideInterval: 24,
    reactionInterval: 32,
    explosionInterval: 48,
    downbeatPos: { x: [-2.2, 2.2], y: [1.0, 2.4], z: [-6.5, -4.5] },
    normalPos:   { x: [-5.5, 5.5], y: [0.5, 3.2], z: [-8, -4.5]   },
    comboPos:    { x: [-6.5, 6.5], y: [0.5, 2.8], z: [-8, -4.5]   },
    slidePos:    { x: [-6.0, 6.0], y: [0.6, 3.4], z: [-8.5, -4]   },
    minDist: 0.6,
  },
};

const SLIDE_DIRECTIONS = [
  { sx: -1, sy:  0, sz: 0, ex: 1, ey: 0,  ez: 0  },
  { sx: 1,  sy:  0, sz: 0, ex: -1, ey: 0,  ez: 0  },
  { sx: -1, sy: 0.5, sz: 0, ex: 1, ey: -0.5, ez: 0 },
  { sx: 0,  sy: -0.5, sz: 0, ex: 0, ey: 0.5, ez: 0 },
  { sx: 0,  sy: 0.8, sz: 0, ex: 0, ey: -0.5, ez: 0 },
];

// ═══════════════════════════════════════════════════
// Pattern 选择器（音频驱动）
// ═══════════════════════════════════════════════════

/**
 * 根据难度 + 能量 + onset 密度从候选池中选取 pattern
 *
 * 高能量 → 选更密集的 pattern（更多拍点）
 * 高 onset 密度 → 选带半拍的 pattern（offbeat 丰富）
 *
 * @param {DifficultyConfig} cfg
 * @param {number} energy 0~1
 * @param {number} onsetDensity 0~1
 * @param {number} seed
 * @returns {number[]}
 */
function selectPattern(cfg, energy, onsetDensity, seed) {
  const pool = cfg.patterns;
  if (pool.length <= 1) return pool[0];

  // 按密度排序（note 数多的排后面）
  const sorted = [...pool].sort((a, b) => a.length - b.length);

  // 能量 0→1 映射到 pool index
  const rawIdx = energy * (sorted.length - 1);
  // onset 密度微调 ±0.5
  const onsetOffset = (onsetDensity - 0.5) * 0.5;
  const idx = Math.round(
    Math.max(0, Math.min(sorted.length - 1, rawIdx + onsetOffset))
  );
  return sorted[idx];
}

// ═══════════════════════════════════════════════════
// 位置生成
// ═══════════════════════════════════════════════════

function generatePosition(cfg, seed, type) {
  let range;
  if (type === 'downbeat' || type === 'charge' || type === 'explosion') {
    range = cfg.downbeatPos;
  } else if (type === 'reaction') {
    range = cfg.normalPos;
  } else if (type === 'combo') {
    range = cfg.comboPos || cfg.normalPos;
  } else if (type === 'slide') {
    range = cfg.slidePos || cfg.normalPos;
  } else if (type === 'trap') {
    range = cfg.normalPos;
  } else {
    range = cfg.normalPos;
  }
  return [
    r3(randRange(seed * 3 + 1, range.x[0], range.x[1])),
    r3(randRange(seed * 5 + 2, range.y[0], range.y[1])),
    r3(randRange(seed * 7 + 3, range.z[0], range.z[1])),
  ];
}

function generatePositionSafe(cfg, seed, type, prevPos, minDist) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pos = generatePosition(cfg, seed + attempt * 997, type);
    if (!prevPos || dist3(pos, prevPos) >= minDist) return pos;
  }
  const pos = generatePosition(cfg, seed + 5000, type);
  if (prevPos && dist3(pos, prevPos) < 0.1) {
    pos[0] += (prevPos[0] > 0 ? -0.6 : 0.6);
    pos[1] += 0.3;
  }
  return pos;
}

// ═══════════════════════════════════════════════════
// LLM 谱面生成（占位函数）
// ═══════════════════════════════════════════════════

/**
 * 调用 LLM API 生成指定段落的谱面 targets。
 *
 * 占位实现：返回 null 时回退到算法生成。
 * 传入有效的 apiKey 后会实际调用 OpenAI / 兼容 API。
 *
 * @param {Object} context
 * @param {string} context.section — 段落名
 * @param {number} context.startMeasure — 起始小节
 * @param {number} context.endMeasure   — 结束小节
 * @param {number} context.bpm
 * @param {number} context.beatInterval
 * @param {string} context.difficulty
 * @param {Array}  context.audioFeatures — 该段落的音频特征
 * @param {string} [context.apiKey] — LLM API key
 * @param {string} [context.model] — 模型名，默认 'gpt-4o-mini'
 * @returns {Promise<Array|null>} targets 数组或 null
 */
async function llmGenerateMeasures(context) {
  const measuresFeatures = context.audioFeatures || [];
  // ========== 1. 构造 System Prompt ==========
  const systemPrompt = `你是一个经验丰富的音乐游戏谱面设计师，擅长将音乐情绪转化为有节奏感的谱面。
你的任务是根据一小段音乐的特征，生成该段落内所有靶子（targets）的列表。

## 谱面格式
返回一个 JSON 数组，每个元素是一个 note 对象：
{
  "time": number,        // 绝对时间（秒），精确到毫秒
  "type": "normal" | "downbeat" | "charge" | "combo" | "slide" | "reaction" | "explosion",
  "position": [x, y, z], // 3D 空间位置，范围 x: [-6,6], y: [0.5,3.5], z: [-8,-4]
  // 可选字段：
  "hitPoints"?: number,           // combo 时需要的击打次数
  "slideDuration"?: number,       // slide 持续时长（秒）
  "startPosition"?: [number,number,number], // slide 起始位置
  "endPosition"?: [number,number,number]    // slide 结束位置
}

## 设计原则
- 密度跟随能量：能量低的小节密度低，多用 normal/downbeat；能量高的副歌加入 combo、slide、reaction。
- 重拍强调：每个小节第一拍（downbeat）用 charge 或 downbeat，让玩家感知节奏。
- 交互感：和弦变化处可增加双押或 combo；乐句末尾可放一个 slide 或 charge 增加收束感。
- 多样性：避免连续 3 个以上完全相同类型的 note，轨道位置不要重复导致视觉疲劳。
- 难度适配：
  - easy：密度低，无 combo/slide/reaction，位置集中在中部。
  - normal：适中密度，出现 combo/slide，位置稍分散。
  - hard：高密度，反应需求高，可用 explosion，位置大范围散布。

## 输出要求
只输出 JSON 数组，不要包含任何解释、注释或 markdown 标记。`;

  // ========== 2. 构造 User Prompt ==========
  const measuresDesc = measuresFeatures.map(m =>
    `- 小节 ${m.measureIndex}：时间 ${(m.startTime || 0).toFixed(2)}s，能量 ${(m.energy || 0).toFixed(2)}，onset密度 ${(m.onsetDensity || 0).toFixed(2)}，和弦 ${m.chord || '无'}`
  ).join('\n');

  const userPrompt = `请为以下音乐段落生成谱面 targets：

难度：${context.difficulty}
BPM：${context.bpm}
段落：${context.section}，时间范围：${context.startTime.toFixed(2)}s 到 ${context.endTime.toFixed(2)}s

各小节特征：
${measuresDesc}

现在请设计该段落的谱面，直接输出 JSON 数组。`;

  // ========== 3. 调用 DeepSeek API ==========
  const baseUrl = context.baseUrl || 'https://api.deepseek.com/v1';
  const model = context.model || 'deepseek-chat';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${context.apiKey || ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.8,       // 创意与稳定之间的平衡
      max_tokens: 4096,
      response_format: { type: 'json_object' } // 强制返回 JSON（若模型支持）
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek API 请求失败 (${response.status}): ${errText}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('DeepSeek 返回内容为空');
  }

  // ========== 4. 解析并验证结果 ==========
  let targets;
  try {
    targets = JSON.parse(content);
  } catch (e) {
    throw new Error(`解析 AI 返回的谱面 JSON 失败: ${e.message}\n内容: ${content}`);
  }

  if (!Array.isArray(targets)) {
    throw new Error('AI 返回的不是一个数组');
  }

  // 简单验证每个 note 的必要字段
  for (const note of targets) {
    if (typeof note.time !== 'number' || !note.type || !Array.isArray(note.position)) {
      throw new Error(`无效的 note 对象: ${JSON.stringify(note)}`);
    }
  }

  console.log(`[LLM] 成功生成 ${targets.length} 个 notes (模型: ${MODEL_NAME})`);
  return targets;
}

// ═══════════════════════════════════════════════════
// 核心生成函数（音频驱动 + LLM 可选）
// ═══════════════════════════════════════════════════

/**
 * @typedef {Object} AudioFeature
 * @property {number}  measureIndex
 * @property {number}  startTime     — 小节开始秒数
 * @property {number}  energy        — 归一化能量 0~1
 * @property {number}  onsetDensity  — onset 数量/小节节拍数
 * @property {string|null} chord     — 和弦标签
 * @property {string|null} section   — 段落标签，覆盖原有判定
 */

/**
 * @typedef {Object} ChartGenOptions
 * @property {number} bpm
 * @property {number} [offset=0]
 * @property {number} duration
 * @property {'easy'|'normal'|'hard'} [difficulty='normal']
 * @property {number} [spawnLeadTime=1.0]
 * @property {boolean} [useLLM=false]
 * @property {string} [llmApiKey]
 * @property {string} [llmModel]
 */

/**
 * 基于音频特征（可选）和 LLM（可选）生成谱面。
 *
 * 不传 audioFeatures 时等价于 generateAutoChart。
 *
 * @param {ChartGenOptions} options
 * @param {AudioFeature[]} [audioFeatures]
 * @returns {Promise<import('./chart.js').Chart>}
 */
export async function generateChartFromAudio(options, audioFeatures) {
  const {
    bpm, offset = 0, duration,
    difficulty = 'normal', spawnLeadTime = 1.0,
    useLLM = false, llmApiKey, llmModel,
  } = options;

  const cfg = CFG[difficulty] || CFG.normal;
  const beatInterval = r3(60 / bpm);

  // ── 时间窗口 ──────────────────────────────────
  let startTime = Math.max(offset + 2.0, 2.0);
  let endTime   = duration - 1.0;
  if (endTime <= startTime) {
    console.warn(`[ChartGen] Song too short (${duration.toFixed(1)}s) — tight margins.`);
    startTime = Math.max(offset + 0.5, 0.5);
    endTime   = Math.max(duration - 0.5, startTime + 0.5);
  }

  const firstBeat = Math.ceil(startTime / beatInterval);
  const lastBeat  = Math.floor(endTime / beatInterval);
  const firstMeasure = Math.floor(firstBeat / 4);
  const lastMeasure  = Math.floor(lastBeat / 4);
  const totalMeasures = lastMeasure - firstMeasure + 1;

  // 构建音频特征索引（按小节号快速查询）
  const featureMap = new Map();
  if (audioFeatures) {
    for (const af of audioFeatures) {
      featureMap.set(af.measureIndex, af);
    }
  }

  /** @type {Array<{ time: number, type: string, position: number[] }>} */
  const targets = [];
  let prevPosition = null;
  let comboBurstRemaining = 0;
  let slideDirIndex = 0;
  const stats = { downbeat: 0, normal: 0, charge: 0, combo: 0, slide: 0, reaction: 0, explosion: 0, trap: 0, llm: 0 };

  // ── 遍历小节，audio-driven pattern 生成 ──────
  for (let m = firstMeasure; m <= lastMeasure; m++) {
    const measureStartBeat = m * 4;
    const feat = featureMap.get(m) || null;

    // 段落：优先音频特征的 section，否则用位置推算
    const section = feat?.section || getSection(m, lastMeasure);
    const sectionIdx = SECTION_NAMES.indexOf(section);

    // 能量和 onset 密度：来自音频特征或默认值
    const energy = feat?.energy ?? 0.5;
    const onsetDensity = feat?.onsetDensity ?? 0.5;

    // 音频驱动 pattern 选择
    const pattern = selectPattern(cfg, energy, onsetDensity, m);

    // ── LLM 模式：对 drop 段调用 LLM ────────────
    if (useLLM && section === 'drop' && m % 8 === 0) {
      try {
        const llmTargets = await llmGenerateMeasures({
          section,
          startMeasure: m,
          endMeasure: Math.min(m + 7, lastMeasure),
          bpm, beatInterval, difficulty,
          audioFeatures: audioFeatures?.filter(af => af.measureIndex >= m && af.measureIndex < m + 8),
          apiKey: llmApiKey,
          model: llmModel,
        });

        if (llmTargets && llmTargets.length > 0) {
          for (const lt of llmTargets) {
            stats.llm = (stats.llm || 0) + 1;
            targets.push(lt);
          }
          m += 7;
          continue;
        }
      } catch (err) {
        console.warn('[ChartGen/LLM] LLM failed, falling back:', err.message);
      }
    }

    // ── 和弦变化检测 → 触发 combo burst ─────────
    const prevFeat = featureMap.get(m - 1) || null;
    const chordChanged = feat && prevFeat &&
      feat.chord && prevFeat.chord &&
      feat.chord !== prevFeat.chord;

    // combo 判定（interval + burst + 和弦变化）
    const comboIntervalHit = cfg.comboInterval > 0 && m > 0 && m % cfg.comboInterval === 0;
    const comboFromBurst = comboBurstRemaining > 0;
    const shouldSpawnCombo = comboIntervalHit || comboFromBurst ||
      (chordChanged && cfg.comboInterval > 0 && energy > 0.6);

    if ((comboIntervalHit || chordChanged) && cfg.comboBurstChance > 0) {
      const burstChance = cfg.comboBurstChance * (1 + energy * 0.5);
      if (mulberry32(m * 7 + 13) < burstChance) {
        comboBurstRemaining = Math.max(comboBurstRemaining, 2);
      }
    }
    if (comboFromBurst) comboBurstRemaining--;

    for (const pb of pattern) {
      const beat = measureStartBeat + (pb - 1);
      const time = r3(beat * beatInterval);
      if (time < startTime || time > endTime) continue;

      // ── 基本类型 ──────────────────────────────
      let type = 'normal';
      if (pb === 1) {
        if (cfg.chargeInterval > 0 && m % cfg.chargeInterval === 0) {
          type = 'charge';
        } else {
          type = 'downbeat';
        }
      }

      const entry = { time, type };

      // ── combo 判定 ────────────────────────────
      if (type === 'normal' && shouldSpawnCombo) {
        entry.type = 'combo';
        entry.hitPoints = cfg.comboHitPoints[sectionIdx] || 3;
      }

      // ── slide 判定（能量驱动：高能量 + chorus 段更容易出现）─────
      const nearCharge = cfg.chargeInterval > 0 &&
        (m % cfg.chargeInterval === 0 || (m + 1) % cfg.chargeInterval === 0);
      const slideIntervalHit = cfg.slideInterval > 0 && m > 0 && m % cfg.slideInterval === 0;
      const slideEnergyBoost = energy > 0.7 && onsetDensity > 0.6;

      if (
        type === 'normal' && entry.type !== 'combo' && cfg.slideInterval > 0 &&
        (slideIntervalHit || (nearCharge && section === 'drop') || slideEnergyBoost)
      ) {
        if (slideIntervalHit || mulberry32(m * 19 + pb * 7) < 0.4) {
          entry.type = 'slide';
          const baseBeats = { easy: 2, normal: 4, hard: 6 }[difficulty] || 4;
          const sectionMul = { intro: 0.8, build: 1.0, drop: 1.3, bridge: 1.2, outro: 0.7 }[section] || 1.0;
          const energyBonus = 1 + energy * 0.5;
          const slideBeats = Math.round(baseBeats * sectionMul * energyBonus);
          entry.slideDuration = r3(slideBeats * beatInterval);
          entry._slideDebug = { baseBeats, sectionMul, energyBonus, slideBeats, section, difficulty };
        }
      }

      // ── reaction 判定 ─────────────────────────
      if (
        type === 'normal' && entry.type !== 'combo' && entry.type !== 'slide' &&
        cfg.reactionInterval > 0 && m > 0 && m % cfg.reactionInterval === 0 &&
        section === 'drop'
      ) {
        entry.type = 'reaction';
      }

      // ── explosion 判定 ────────────────────────
      if (
        type === 'downbeat' &&
        cfg.explosionInterval > 0 && m > 0 && m % cfg.explosionInterval === 0
      ) {
        entry.type = 'explosion';
      }

      // ── trap 判定：随机替换 normal 拍 ─────────
      if (
        type === 'normal' &&
        entry.type !== 'combo' && entry.type !== 'slide' && entry.type !== 'reaction' &&
        cfg.trapChance > 0 &&
        mulberry32(m * 31 + pb * 17) < cfg.trapChance
      ) {
        entry.type = 'trap';
      }
      const positionSeed = m * 100 + Math.round(pb * 100);
      const position = generatePositionSafe(cfg, positionSeed, entry.type, prevPosition, cfg.minDist);
      prevPosition = position;
      entry.position = position;

      if (entry.type === 'slide') {
        const dir = SLIDE_DIRECTIONS[slideDirIndex % SLIDE_DIRECTIONS.length];
        slideDirIndex++;
        const spread = randRange(positionSeed + 200, 2.5, 5);
        entry.startPosition = [
          r3(position[0] + dir.sx * spread),
          r3(Math.max(0.6, position[1] + dir.sy * spread)),
          position[2],
        ];
        entry.endPosition = [
          r3(position[0] + dir.ex * spread),
          r3(Math.max(0.6, position[1] + dir.ey * spread)),
          position[2],
        ];
      }

      stats[entry.type] = (stats[entry.type] || 0) + 1;
      targets.push(entry);
    }
  }

  // ── 过滤 trap（封印） + 排序 ─────────────────
  const filteredTargets = targets.filter(t => t.type !== 'trap');
  if (filteredTargets.length < targets.length) {
    console.log(`[ChartGen] Stripped ${targets.length - filteredTargets.length} trap target(s).`);
  }
  filteredTargets.sort((a, b) => a.time - b.time);

  const total = filteredTargets.length;
  const typeBreakdown = Object.entries(stats)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t}:${n}`)
    .join('  ');
  const first5 = filteredTargets.slice(0, 5).map(t =>
    `  t=${t.time.toFixed(3)}s  ${t.type.padEnd(8)}  [${t.position.map(v => v.toFixed(1)).join(', ')}]`
  );
  const last5 = filteredTargets.slice(-5).map(t =>
    `  t=${t.time.toFixed(3)}s  ${t.type.padEnd(8)}  [${t.position.map(v => v.toFixed(1)).join(', ')}]`
  );

  console.log(
    `[ChartGen] ${difficulty.toUpperCase()}  targets=${total}  ` +
    `BPM=${bpm}  duration=${duration.toFixed(1)}s  ` +
    `measures=${firstMeasure}→${lastMeasure}  ` +
    `audioDriven=${!!audioFeatures}  llm=${useLLM}`
  );
  console.log(`[ChartGen] Types: ${typeBreakdown}`);
  if (total > 0) {
    console.log(`[ChartGen] First ${Math.min(5, total)}:\n` + first5.join('\n'));
    console.log(`[ChartGen] Last ${Math.min(5, total)}:\n` + last5.join('\n'));
  }

  return {
    songId: 'auto_generated',
    bpm, offset, duration,
    spawnLeadTime,
    sizeMultiplier: cfg.sizeMultiplier || 1.0,
    targets: filteredTargets,
  };
}

// ═══════════════════════════════════════════════════
// 向后兼容：纯算法生成
// ═══════════════════════════════════════════════════

/**
 * 纯算法生成谱面（向后兼容）。
 * 内部调用 generateChartFromAudio，不传音频特征。
 *
 * @param {ChartGenOptions} options
 * @returns {Promise<import('./chart.js').Chart>}
 */
export function generateAutoChart(options) {
  return generateChartFromAudio(options, null);
}
