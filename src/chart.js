/**
 * chart.js — 谱面加载模块
 *
 * 用法：
 *   import { loadChart } from './chart.js';
 *   const chart = await loadChart('/charts/test-chart.json');
 *
 * 谱面 JSON 格式参见 public/charts/test-chart.json
 */

/**
 * @typedef {Object} ChartTarget
 * @property {number}   time     - 命中时间 (秒, 相对音乐开始)
 * @property {string}   type     - 'normal' | 'downbeat' | 'charge'
 * @property {number[]} position - [x, y, z] 世界坐标
 */

/**
 * @typedef {Object} Chart
 * @property {string}        songId
 * @property {number}        bpm
 * @property {number}        offset
 * @property {number}        spawnLeadTime
 * @property {number}        [duration]       - 歌曲时长 (秒), 0 或不存在时使用音频真实时长
 * @property {boolean}       [autoGenerate]   - true 时调用 generateAutoChart 生成完整谱面
 * @property {ChartTarget[]} targets          - 手写靶子列表 (autoGenerate=false 时使用)
 */

/**
 * 加载 JSON 谱面文件
 *
 * @param {string} url — 谱面路径，例如 '/charts/test-chart.json'
 * @returns {Promise<Chart>}
 */
export async function loadChart(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} — ${response.statusText}`);
    }

    /** @type {Chart} */
    const chart = await response.json();

    // 基础校验
    if (!chart.targets || !Array.isArray(chart.targets)) {
      throw new Error('Chart is missing "targets" array.');
    }

    console.log(
      `[Chart] Loaded "${url}"  —  ${chart.targets.length} targets, ` +
      `BPM=${chart.bpm}, offset=${chart.offset}s, spawnLead=${chart.spawnLeadTime}s`
    );

    return chart;
  } catch (err) {
    console.error(`[Chart] Failed to load "${url}" — ${err.message}`);
    throw err;
  }
}
