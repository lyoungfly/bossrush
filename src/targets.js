/**
 * targets.js — 靶子管理模块 (TargetManager)
 *
 * 职责：
 *   - 按谱面时间流式生成靶子（不一次性全量加入场景）
 *   - 靶子生命周期：提前出现 → 可命中 → 过期移除
 *   - 通过 onMiss 回调通知外部（不直接操控 UI / 计分）
 *
 * 用法：
 *   import { targetManager } from './targets.js';
 *   targetManager.setChart(chart);
 *   targetManager.onMiss = (t) => { ... };
 *   targetManager.update(songTime);   // 每帧调用
 */

import * as THREE from 'three';
import { scene } from './scene.js';

// ═══════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════

/** 靶子 hitTime 后未命中即视为 Miss 的时间窗口 (秒) */
const DEFAULT_MISS_WINDOW = 0.2;

/** 靶子类型 → 外观配置 */
const TYPE_CONFIG = {
  normal:   { color: 0x00ffff, radius: 0.38, emissiveIntensity: 0.55, approachMax: 2.5, approachBrightness: 0.5, tubeRadius: 0.10 },
  downbeat: { color: 0xff00ff, radius: 0.58, emissiveIntensity: 0.65, approachMax: 3.0, approachBrightness: 0.8, tubeRadius: 0.14 },
  charge:   { color: 0xffff00, radius: 0.50, emissiveIntensity: 0.60, approachMax: 2.8, approachBrightness: 0.65, tubeRadius: 0.12 },
  combo:    { color: 0xff8800, radius: 0.48, emissiveIntensity: 0.65, approachMax: 2.8, approachBrightness: 0.7, tubeRadius: 0.11 },
  slide:    { color: 0x44ff88, radius: 0.42, emissiveIntensity: 0.60, approachMax: 2.5, approachBrightness: 0.6, tubeRadius: 0.09 },
  reaction: { color: 0xff3333, radius: 0.32, emissiveIntensity: 0.70, approachMax: 3.5, approachBrightness: 0.9, tubeRadius: 0.08 },
  explosion:{ color: 0xffffff, radius: 0.50, emissiveIntensity: 0.80, approachMax: 2.0, approachBrightness: 0.9, tubeRadius: 0.15 },
  trap:     { color: 0x883388, radius: 0.36, emissiveIntensity: 0.50, approachMax: 2.5, approachBrightness: 0.45, tubeRadius: 0.07 },
};

/** combo 靶子每次点击之间的最大间隔 (秒) */
const COMBO_HIT_INTERVAL = 0.18;

/** slide 靶子追踪得分阈值（百分比） */
const SLIDE_SUCCESS_THRESHOLD = 0.6;

// ═══════════════════════════════════════════════════
// 外环颜色系统
// ═══════════════════════════════════════════════════

/** 外环当前颜色（所有靶子视觉同步） */
let _currentRingColor = 0x00ffff;

/** 外环颜色切换时，更新所有活跃靶子的材质 */
function _applyRingColorToTarget(target, color) {
  target._ringColor = color;
  // 遍历 target mesh 的所有子对象
  target.mesh.traverse(child => {
    if (!child.material) return;
    // 更新 emissive（MeshStandardMaterial）
    if (child.material.emissive !== undefined && child.material.emissive.set) {
      child.material.emissive.set(color);
    }
    // 更新 color（MeshBasicMaterial）
    if (child.material.color && child.material.color.set) {
      child.material.color.set(color);
    }
  });
  // 更新连线（在 _connections 中处理）
}

/**
 * 设置外环颜色，同步更新所有现有靶子
 * @param {number} hexColor
 */
export function setRingColor(hexColor) {
  if (hexColor === _currentRingColor) return;
  _currentRingColor = hexColor;
  // 更新所有活跃靶子
  for (const t of targetManager.targets) {
    _applyRingColorToTarget(t, hexColor);
  }
  // 更新连线
  for (const conn of targetManager._connections) {
    if (conn.line && conn.line.material && conn.line.material.color) {
      conn.line.material.color.set(hexColor);
    }
  }
  console.log(`[RingColor] Switched to 0x${hexColor.toString(16).padStart(6, '0')}`);
}

/** 获取当前外环颜色 */
export function getRingColor() {
  return _currentRingColor;
}

/** 外环初始最大缩放倍数（在 spawn 时） */
const APPROACH_RING_TUBE = 0.05;

// ═══════════════════════════════════════════════════
// TargetManager
// ═══════════════════════════════════════════════════

class TargetManager {
  constructor() {
    /**
     * 当前场景中的活跃靶子列表
     * @type {Array<{ mesh: THREE.Group, hitTime: number, type: string, isHit: boolean }>}
     */
    this.targets = [];

    // ── 谱面数据 ────────────────────────────────
    /** @type {Array<{ time: number, type: string, position: number[] }>} */
    this._chartTargets = [];

    /** 下一个待生成的靶子索引（chart.targets 按 time 升序） */
    this._nextSpawnIndex = 0;

    /** 靶子提前出现时间 (秒) */
    this._spawnLeadTime = 1.0;

    /** Miss 判定窗口 (秒) */
    this._missWindow = DEFAULT_MISS_WINDOW;

    /**
     * 靶子过期未命中回调
     * @type {Function | null}
     */
    this.onMiss = null;

    /** 靶子间连线 [{ line: THREE.Line, fromTarget, toTarget }] */
    this._connections = [];

    /** 当前唯一可交互靶子（全场同一时刻只有一个） */
    this._currentTarget = null;
  }

  // ═════════════════════════════════════════════════
  // 谱面加载
  // ═════════════════════════════════════════════════

  /**
   * 设置谱面数据，清除旧靶子并重置所有状态
   *
   * @param {import('./chart.js').Chart} chart
   */
  setChart(chart) {
    this.clear();

    let raw = chart.targets || [];

    // 验证 + 排序
    raw = raw.filter(t => {
      if (typeof t.time !== 'number' || t.time < 0) {
        console.warn('[TargetManager] Skipping invalid target:', t);
        return false;
      }
      return true;
    });
    raw.sort((a, b) => a.time - b.time);

    // 确保每个 target 有 position（默认/随机）
    raw = raw.map(t => {
      if (!t.position || !Array.isArray(t.position) || t.position.length < 3) {
        t.position = [
          THREE.MathUtils.randFloat(-3, 3),
          THREE.MathUtils.randFloat(1.0, 2.4),
          THREE.MathUtils.randFloat(-7, -5),
        ];
      }
      return t;
    });

    this._chartTargets = raw;
    this._nextSpawnIndex = 0;
    this._spawnLeadTime = chart.spawnLeadTime ?? 1.0;
    this._sizeMultiplier = chart.sizeMultiplier || 1.0;

    console.log(
      `[TargetManager] Chart set — ${this._chartTargets.length} targets (sorted, validated), ` +
      `spawnLead=${this._spawnLeadTime}s, missWindow=${this._missWindow}s`
    );
  }

  /**
   * @deprecated 使用 setChart() 代替
   */
  loadChartData(chart) {
    this.setChart(chart);
  }

  // ═════════════════════════════════════════════════
  // 每帧更新
  // ═════════════════════════════════════════════════

  /**
   * 驱动靶子生命周期（每帧调用）
   *
   *   1. 流式生成：当前 songTime 到达 spawn 窗口的靶子逐一生成
   *   2. 过期清理：hitTime 后超过 missWindow 未命中的靶子移除 + onMiss
   *
   * 复杂度 O(N_active)，不随谱面总靶子数增长。
   *
   * @param {number} songTime — 当前音乐时间 (秒)
   */
  update(songTime) {
    // ── 流式生成：只检查下一个待生成靶子 ──────────
    while (this._nextSpawnIndex < this._chartTargets.length) {
      const ct = this._chartTargets[this._nextSpawnIndex];

      if (songTime >= ct.time - this._spawnLeadTime) {
        this._spawnOne(ct);
        this._nextSpawnIndex++;
      } else {
        // chartTargets 按 time 升序排列，后续更晚，无需继续
        break;
      }
    }

    // ── Approach ring 动画 ──────────────────────
    for (const t of this.targets) {
      if (t._approachRing && !t.isHit) {
        const progress = Math.min(
          (songTime - t.spawnTime) / (t.hitTime - t.spawnTime), 1.0
        );
        const scale = 1 + (t._approachMax - 1) * (1 - progress);
        t._approachRing.scale.set(scale, scale, scale);

        // 接近 hitTime 时外环加速闪烁
        if (progress > 0.85) {
          const flash = 0.5 + 0.5 * Math.sin(songTime * 30);
          t._approachRing.material.opacity =
            TYPE_CONFIG[t.type]?.approachBrightness * (0.6 + 0.4 * flash);
        }
      }
    }

    // ── Slide 移动更新 ───────────────────────
    for (const t of this.targets) {
      if (t.type === 'slide' && t._startPos && t._endPos) {
        const raw = (songTime - t.slideStartTime) / (t.slideEndTime - t.slideStartTime);
        t.slideProgress = Math.max(0, Math.min(1, raw));
        const pos = new THREE.Vector3().lerpVectors(t._startPos, t._endPos, t.slideProgress);
        t.mesh.position.copy(pos);

        // 流动点沿轨迹循环
        if (t._flowDots) {
          for (const dot of t._flowDots) {
            const p = (dot.userData.phase + songTime * 0.6) % 1;
            dot.position.lerpVectors(t._startPos, t._endPos, p);
            dot.material.opacity = 0.3 + 0.4 * (1 - Math.abs(p - t.slideProgress) * 3);
          }
        }
      }
    }
    // slide 管线跟随移动
    this._updateSlideConnections();

    // ── 确定可交互靶子（slide 与非 slide 独立）──
    this._currentTarget = null;
    this._currentSlideTarget = null;
    for (const t of this.targets) {
      if (t.isHit) continue;
      const expire = t.type === 'combo' ? t._comboExpireTime
        : t.type === 'slide' ? t.slideEndTime + this._missWindow
        : t.hitTime + this._missWindow;
      if (songTime >= t.spawnTime && songTime <= expire) {
        if (t.type === 'slide') {
          if (!this._currentSlideTarget) this._currentSlideTarget = t;
        } else {
          if (!this._currentTarget) this._currentTarget = t;
        }
        // 如果两个都已经找到，提前退出
        if (this._currentTarget && this._currentSlideTarget) break;
      }
    }

    // slide 独占日志
    if (this._currentSlideTarget && !this._currentSlideTarget._blockLogged) {
      this._currentSlideTarget._blockLogged = true;
      console.log(
        `[TargetManager] Slide active — hold SPACE to track | ` +
        `end=${this._currentSlideTarget.slideEndTime.toFixed(2)}s ` +
        `(${((this._currentSlideTarget.slideEndTime - songTime) * 1000).toFixed(0)}ms)`
      );
    }

    // ── 连线脉冲 ──────────────────────────────
    for (let ci = 0; ci < this._connections.length; ci++) {
      const conn = this._connections[ci];
      const isNext = ci === this._connections.length - 1;
      // 指向下一靶的连线更亮，脉冲幅度更大
      const base = isNext ? 0.30 : 0.16;
      const amp  = isNext ? 0.12 : 0.06;
      conn.line.material.opacity = base + amp * Math.sin(songTime * 8);
    }

    // ── 过期检查：反向遍历，安全删除 ─────────────
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i];

      if (t.type === 'combo') {
        if (songTime > t._comboExpireTime && t.hitPoints > 0) {
          t._partialFail = true;
          this.removeTarget(t);
          if (this.onMiss) this.onMiss(t);
        }
      } else if (t.type === 'slide') {
        // slide 靶子：slideEndTime 后判定
        if (songTime > t.slideEndTime + this._missWindow) {
          t._slideFinished = true;
          this.removeTarget(t);
          if (this.onMiss) this.onMiss(t);
        }
      } else {
        // 普通靶子
        if (!t.isHit && songTime > t.hitTime + this._missWindow) {
          this.removeTarget(t);
          if (this.onMiss) this.onMiss(t);
        }
      }
    }
  }

  // ═════════════════════════════════════════════════
  // 内部：从谱面条目生成单个靶子 Mesh
  // ═════════════════════════════════════════════════

  /**
   * 创建靶子 Three.js Mesh 并加入场景
   *
   * @param {{ time: number, type: string, position: number[] }} chartTarget
   */
  _spawnOne(chartTarget) {
    const type = chartTarget.type || 'normal';
    const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.normal;

    const group = new THREE.Group();

    // 应用难度尺寸倍率
    const sizeMul = this._sizeMultiplier || 1.0;
    const r = cfg.radius * sizeMul;

    // 中心球 — 使用外环颜色
    const ringColor = _currentRingColor;
    const sphereGeo = new THREE.SphereGeometry(r, 24, 24);
    const sphereMat = new THREE.MeshStandardMaterial({
      color: ringColor,
      emissive: ringColor,
      emissiveIntensity: cfg.emissiveIntensity,
      roughness: 0.25,
      metalness: 0.1,
    });
    group.add(new THREE.Mesh(sphereGeo, sphereMat));

    // 外环
    const ringGeo = new THREE.TorusGeometry(r + 0.12 * sizeMul, 0.05 * sizeMul, 16, 32);
    const ringMat = new THREE.MeshStandardMaterial({
      color: ringColor,
      emissive: ringColor,
      emissiveIntensity: cfg.emissiveIntensity + 0.2,
      roughness: 0.2,
      metalness: 0.1,
    });
    group.add(new THREE.Mesh(ringGeo, ringMat));

    // 位置
    const pos = chartTarget.position;
    if (pos && pos.length >= 3) {
      group.position.set(pos[0], pos[1], pos[2]);
    } else {
      group.position.set(
        THREE.MathUtils.randFloat(-3, 3),
        THREE.MathUtils.randFloat(1, 3),
        THREE.MathUtils.randFloat(-8, -5)
      );
    }

    // Approach ring — 从大到小收缩，hitTime 时刚好接触靶子边缘
    const appRingGeo = new THREE.TorusGeometry(r, APPROACH_RING_TUBE * sizeMul, 16, 48);
    const isSlide = type === 'slide';
    const appRingMat = new THREE.MeshBasicMaterial({
      color: ringColor,
      transparent: true,
      opacity: isSlide ? 0.45 : cfg.approachBrightness,
      depthWrite: false,
    });
    const appRing = new THREE.Mesh(appRingGeo, appRingMat);
    appRing.scale.set(cfg.approachMax, cfg.approachMax, cfg.approachMax);
    appRing.raycast = () => {};
    group.add(appRing);

    group.lookAt(group.position.x, group.position.y, 10);

    // reaction 靶: 更短的预警时间
    const leadTime = type === 'reaction' ? 0.35 : this._spawnLeadTime;

    const target = {
      mesh: group,
      hitTime: chartTarget.time,
      spawnTime: chartTarget.time - leadTime,
      type,
      isHit: false,
      _ringColor: ringColor,
      _approachRing: appRing,
      _approachMax: cfg.approachMax,
    };

    // combo 靶子额外属性
    if (type === 'combo') {
      const maxHp = chartTarget.hitPoints || 3;
      target.hitPoints = maxHp;
      target.maxHitPoints = maxHp;
      target._lastHitTime = -Infinity;
      target._comboExpireTime = chartTarget.time + this._missWindow + (maxHp - 1) * COMBO_HIT_INTERVAL;

      const progressGeo = new THREE.TorusGeometry(cfg.radius + 0.25, 0.06, 16, 64, Math.PI * 2);
      const progressMat = new THREE.MeshBasicMaterial({
        color: cfg.color, transparent: true, opacity: 0.7, depthWrite: false,
      });
      target._progressRing = new THREE.Mesh(progressGeo, progressMat);
      target._progressRing.raycast = () => {};
      group.add(target._progressRing);
    }

    // slide 靶子额外属性
    if (type === 'slide') {
      const slideDuration = chartTarget.slideDuration || 2.0;
      target.slideStartTime = chartTarget.time;
      target.slideEndTime = chartTarget.time + slideDuration;
      target.slideProgress = 0;
      target.totalCharge = 0;
      target._isTracked = false;

      const debug = chartTarget._slideDebug || {};
      console.log(
        `[TargetManager] Slide spawned — duration=${slideDuration.toFixed(2)}s ` +
        `(base=${debug.baseBeats} beats × sectionMul=${debug.sectionMul} → ${debug.slideBeats} beats) ` +
        `start=${chartTarget.time.toFixed(2)}s end=${target.slideEndTime.toFixed(2)}s ` +
        `section=${debug.section} difficulty=${debug.difficulty} ` +
        `| BLOCKING subsequent targets until resolved`
      );

      // 起止位置
      const startPos = chartTarget.startPosition || [
        chartTarget.position[0] - 3, chartTarget.position[1], chartTarget.position[2]
      ];
      const endPos = chartTarget.endPosition || [
        chartTarget.position[0] + 3, chartTarget.position[1], chartTarget.position[2]
      ];
      target._startPos = new THREE.Vector3(...startPos);
      target._endPos = new THREE.Vector3(...endPos);

      // 初始位置 = startPosition
      group.position.copy(target._startPos);

      // ── 轨迹虚线（虚线 + AdditiveBlending 发光）──
      const trajPts = [target._startPos.clone(), target._endPos.clone()];
      const trajGeo = new THREE.BufferGeometry().setFromPoints(trajPts);
      const trajMat = new THREE.LineDashedMaterial({
        color: cfg.color,
        transparent: true,
        opacity: 0.45,
        dashSize: 0.6,
        gapSize: 0.35,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      target._trajectoryLine = new THREE.Line(trajGeo, trajMat);
      target._trajectoryLine.computeLineDistances();
      target._trajectoryLine.raycast = () => {};
      scene.add(target._trajectoryLine);

      // ── 流动点（沿轨迹移动的小球）───────────────
      target._flowDots = [];
      for (let d = 0; d < 4; d++) {
        const dotGeo = new THREE.SphereGeometry(0.04, 6, 6);
        const dotMat = new THREE.MeshBasicMaterial({
          color: cfg.color,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.raycast = () => {};
        dot.userData = { phase: d / 4 };
        scene.add(dot);
        target._flowDots.push(dot);
      }

      // ── 本体方向箭头（2 个锥体指向终点）─────────
      const arrowDir = new THREE.Vector3().subVectors(target._endPos, target._startPos).normalize();
      for (let a = 0; a < 2; a++) {
        const coneGeo = new THREE.ConeGeometry(0.08, 0.18, 6, 8);
        const coneMat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.position.copy(
          new THREE.Vector3().lerpVectors(target._startPos, target._endPos, 0.3 + a * 0.4)
        );
        // 圆锥默认沿 Y 轴，旋转到轨迹方向
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), arrowDir);
        cone.raycast = () => {};
        scene.add(cone);
        target._arrows = target._arrows || [];
        target._arrows.push(cone);
      }

      // ── 本体双环（区分普通靶子）─────────────────
      // 内环（原有外环已加），额外加一个更细更亮的环
      const slideRingGeo = new THREE.TorusGeometry(cfg.radius + 0.18, 0.03, 16, 32);
      const slideRingMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const slideRing = new THREE.Mesh(slideRingGeo, slideRingMat);
      slideRing.raycast = () => {};
      target._slideDistinctRing = slideRing;
      group.add(slideRing);

      // ── 充能进度环 ────────────────────────────
      const chargeGeo = new THREE.TorusGeometry(cfg.radius + 0.25, 0.05, 16, 64);
      const chargeMat = new THREE.MeshBasicMaterial({
        color: cfg.color,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
      target._chargeRing = new THREE.Mesh(chargeGeo, chargeMat);
      target._chargeRing.raycast = () => {};
      group.add(target._chargeRing);
    }

    this.targets.push(target);
    scene.add(group);

    // 连线：上一个靶子 → 当前靶子（按出现顺序）
    if (this.targets.length >= 2) {
      this._addConnection(
        this.targets[this.targets.length - 2],
        this.targets[this.targets.length - 1]
      );
    }
  }

  // ═════════════════════════════════════════════════
  // 连线（内部）
  // ═════════════════════════════════════════════════

  /**
   * 在两个靶子之间创建半透明连线
   * 颜色跟随 toTarget 的类型
   */
  _addConnection(fromTarget, toTarget) {
    const cfg = TYPE_CONFIG[toTarget.type] || TYPE_CONFIG.normal;
    const r = cfg.tubeRadius || 0.10;

    const from = fromTarget.mesh.position;
    const to   = toTarget.mesh.position;
    const dir  = new THREE.Vector3().subVectors(to, from);
    const dist = dir.length();
    if (dist < 0.01) return;

    const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);

    const tubeGeo = new THREE.CylinderGeometry(r, r, 1, 8, 1, true);
    const tubeMat = new THREE.MeshBasicMaterial({
      color: cfg.color,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.position.copy(mid);
    tube.scale.set(1, dist, 1);
    tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    tube.raycast = () => {};
    scene.add(tube);

    const isSlide = fromTarget.type === 'slide' || toTarget.type === 'slide';
    this._connections.push({ line: tube, fromTarget, toTarget, _isSlide: isSlide, _tubeRadius: r });
  }

  /** 更新 slide 相关管线的位置和朝向 */
  _updateSlideConnections() {
    for (const conn of this._connections) {
      if (!conn._isSlide) continue;
      const from = conn.fromTarget.mesh.position;
      const to   = conn.toTarget.mesh.position;
      const dir  = new THREE.Vector3().subVectors(to, from);
      const dist = dir.length();
      if (dist < 0.01) continue;
      const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
      conn.line.position.copy(mid);
      conn.line.scale.set(1, dist, 1);
      conn.line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    }
  }

  _removeConnectionsFor(target) {
    for (let i = this._connections.length - 1; i >= 0; i--) {
      const conn = this._connections[i];
      if (conn.fromTarget === target || conn.toTarget === target) {
        scene.remove(conn.line);
        conn.line.geometry.dispose();
        conn.line.material.dispose();
        this._connections.splice(i, 1);
      }
    }
  }

  _removeAllConnections() {
    for (const conn of this._connections) {
      scene.remove(conn.line);
      conn.line.geometry.dispose();
      conn.line.material.dispose();
    }
    this._connections = [];
  }

  // ═════════════════════════════════════════════════
  // combo 靶子专用
  // ═════════════════════════════════════════════════

  /**
   * 扣除 combo 靶子 1 点生命值
   * @param {Object} target
   * @param {number} songTime
   * @returns {{ destroyed: boolean, remaining: number, lastHit: boolean }}
   */
  hitComboTarget(target, songTime) {
    if (target.type !== 'combo' || target.hitPoints <= 0) {
      return { destroyed: false, remaining: 0, lastHit: false };
    }

    target.hitPoints--;
    target._lastHitTime = songTime;

    const destroyed = target.hitPoints <= 0;
    const remaining = target.hitPoints;

    // 更新进度环
    this._updateComboProgressRing(target);

    // 核心闪烁反馈
    this._flashComboCore(target);

    return { destroyed, remaining, lastHit: destroyed };
  }

  /** 更新 combo 进度环（根据剩余 HP 调整弧长） */
  _updateComboProgressRing(target) {
    const ring = target._progressRing;
    if (!ring) return;

    const ratio = target.hitPoints / target.maxHitPoints;
    ring.scale.set(ratio, ratio, 1);
    ring.material.opacity = 0.25 + ratio * 0.55;
    // 固定橙色，通过透明度和缩放表示进度
    ring.material.color.set(0xff8800);
  }

  /**
   * slide 靶子被按住时调用（空格键），累积充能
   * @param {Object} target
   * @param {number} dt — delta time
   * @returns {{ charge: number, threshold: number, reached: boolean }}
   */
  trackSlideTarget(target, dt) {
    if (target.type !== 'slide') return { charge: 0, threshold: 1, reached: false };

    target.totalCharge = Math.min(1, target.totalCharge + dt * 0.8);
    target._isTracked = true;

    // 更新充能环
    if (target._chargeRing) {
      target._chargeRing.scale.set(target.totalCharge, target.totalCharge, 1);
      // 固定 slide 绿色，透明度随充能增加
      target._chargeRing.material.color.set(0x44ff88);
      target._chargeRing.material.opacity = 0.3 + target.totalCharge * 0.5;
    }

    return {
      charge: target.totalCharge,
      threshold: SLIDE_SUCCESS_THRESHOLD,
      reached: target.totalCharge >= SLIDE_SUCCESS_THRESHOLD,
    };
  }

  /** slide 靶子松开空格时泄能 */
  drainSlideTarget(target, dt) {
    if (target.type !== 'slide') return;
    target.totalCharge = Math.max(0, target.totalCharge - dt * 0.4);
    target._isTracked = false;
    if (target._chargeRing) {
      target._chargeRing.scale.set(target.totalCharge, target.totalCharge, 1);
    }
  }

  /**
   * 命中时靶子闪白 + 缩放脉冲（所有类型通用）
   * @param {Object} target
   * @param {'Perfect'|'Good'|'Miss'} judgment
   */
  flashTargetOnHit(target, judgment) {
    if (!target.mesh || !target.mesh.children) return;
    const sphere = target.mesh.children[0];
    if (!sphere || !sphere.material) return;

    const isPerfect = judgment === 'Perfect';
    const isMiss = judgment === 'Miss';

    if (sphere.material.emissive) {
      const origColor = sphere.material.emissive.getHex();
      const origIntensity = sphere.material.emissiveIntensity;
      sphere.material.emissive.set(isPerfect ? 0xffffff : isMiss ? 0xff4444 : 0xccffff);
      sphere.material.emissiveIntensity = isPerfect ? 1.4 : isMiss ? 0.7 : 1.0;
      setTimeout(() => {
        if (sphere.material) {
          sphere.material.emissive.set(origColor);
          sphere.material.emissiveIntensity = origIntensity;
        }
      }, isPerfect ? 150 : 100);
    }

    // 缩放脉冲
    const origScale = sphere.scale.x;
    const pulseScale = isPerfect ? 1.5 : isMiss ? 0.85 : 1.2;
    sphere.scale.setScalar(pulseScale);
    const dur = isPerfect ? 150 : 100;
    setTimeout(() => { sphere.scale.setScalar(origScale); }, dur);
  }

  /** combo 核心闪白 + 缩放脉冲 */
  _flashComboCore(target) {
    if (!target.mesh || !target.mesh.children) return;
    const sphere = target.mesh.children[0];
    if (!sphere || !sphere.material || !sphere.material.emissive) return;

    const isLastHit = target.hitPoints <= 1;

    // 闪白
    const origColor = sphere.material.emissive.getHex();
    const origIntensity = sphere.material.emissiveIntensity;
    sphere.material.emissive.set(isLastHit ? 0xffffff : 0xffddcc);
    sphere.material.emissiveIntensity = isLastHit ? 1.2 : 0.9;

    // 缩放脉冲
    const origScale = sphere.scale.x;
    sphere.scale.setScalar(isLastHit ? 1.4 : 1.15);

    const dur = isLastHit ? 120 : 80;
    setTimeout(() => {
      if (sphere.material) {
        sphere.material.emissive.set(origColor);
        sphere.material.emissiveIntensity = origIntensity;
      }
      sphere.scale.setScalar(origScale);
    }, dur);
  }

  // ═════════════════════════════════════════════════
  // 查询
  // ═════════════════════════════════════════════════

  /**
   * 获取所有活跃靶子的 Three.js Mesh（供 raycaster 使用）
   * @returns {THREE.Group[]}
   */
  /**
   * 获取左键可交互靶子（slide 由空格处理，不在此返回）
   * @returns {THREE.Group[]}
   */
  getTargetMeshes() {
    if (this._currentTarget && !this._currentTarget.isHit && this._currentTarget.type !== 'slide') {
      return [this._currentTarget.mesh];
    }
    return [];
  }

  /**
   * 获取当前活跃的 slide 靶子（供空格键使用）
   */
  getCurrentSlideTarget() {
    return this._currentSlideTarget || null;
  }

  /**
   * 根据射线命中的子对象反查所属 target
   *
   * @param {THREE.Object3D} childMesh — intersects[0].object
   * @returns {Object | null}
   */
  getTargetByMesh(childMesh) {
    let obj = childMesh;
    while (obj) {
      const found = this.targets.find((t) => t.mesh === obj);
      if (found) return found;
      obj = obj.parent;
    }
    return null;
  }

  /**
   * 剩余靶子数量（未生成 + 场景中活跃）
   * @returns {number}
   */
  getRemainingCount() {
    const unspawned = this._chartTargets.length - this._nextSpawnIndex;
    return unspawned + this.targets.length;
  }

  /**
   * 谱面是否全部处理完毕
   * （全部已生成 且 场景中无活跃靶子）
   * @returns {boolean}
   */
  isFinished() {
    return (
      this._nextSpawnIndex >= this._chartTargets.length &&
      this.targets.length === 0
    );
  }

  // ═════════════════════════════════════════════════
  // 移除 / 清空
  // ═════════════════════════════════════════════════

  /**
   * 从场景和列表中移除单个靶子，释放 GPU 资源
   *
   * @param {Object} target
   */
  /**
   * 爆炸靶命中时连锁清除附近靶子
   * @returns {Array} 被连锁清除的靶子列表
   */
  _explosionChain(target, songTime) {
    const chained = [];
    if (target.type !== 'explosion') return chained;

    const timeRadius = 1.0; // ±1 秒内的靶子
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i];
      if (t === target || t.isHit) continue;
      if (Math.abs(t.hitTime - target.hitTime) <= timeRadius) {
        chained.push(t);
      }
    }
    return chained;
  }

  /**
   * 统一销毁靶子：从 scene 移除 + 释放 GPU 资源 + 清理关联对象
   * 所有靶子类型都走这条链路
   */
  removeTarget(target) {
    const idx = this.targets.indexOf(target);
    if (idx === -1) return;

    const chained = target.type === 'explosion' ? this._explosionChain(target) : [];

    // 1. 移除所有连线
    this._removeConnectionsFor(target);
    for (const ct of chained) this._removeConnectionsFor(ct);

    // 2. 先移除主靶（避免连锁删除导致 index 偏移）
    this.targets.splice(idx, 1);
    _disposeTargetMesh(target);

    // 3. 桥接连线：prev → next（基于移除后的数组）
    const newIdx = idx; // 主靶已移除，chained 还在
    if (newIdx > 0 && newIdx <= this.targets.length) {
      const prev = this.targets[newIdx - 1];
      const next = this.targets[newIdx] || null;
      // 仅当 prev 和 next 都不是刚被连锁移除的
      if (prev && !chained.includes(prev) && next && !chained.includes(next)) {
        this._addConnection(prev, next);
      }
    }

    // 4. 移除爆炸连锁靶子（逆序避免 index 偏移）
    for (let i = chained.length - 1; i >= 0; i--) {
      const ci = this.targets.indexOf(chained[i]);
      if (ci !== -1) this.targets.splice(ci, 1);
      _disposeTargetMesh(chained[i]);
    }

    console.log(
      `[TargetManager] Destroyed: type=${target.type} hitTime=${target.hitTime?.toFixed(2)}s` +
      (chained.length ? ` +${chained.length} chained` : '')
    );
  }

  /**
   * 清除所有状态（靶子 + 谱面数据 + 索引）
   */
  clear() {
    this._removeAllConnections();
    for (let i = this.targets.length - 1; i >= 0; i--) {
      _disposeTargetMesh(this.targets[i]);
    }
    this.targets = [];
    this._chartTargets = [];
    this._nextSpawnIndex = 0;
  }
}

// ═════════════════════════════════════════════════
// 模块级工具（不依赖 TargetManager 实例）
// ═════════════════════════════════════════════════

/** 销毁单个靶子的所有 Three.js 对象 */
function _disposeTargetMesh(target) {
  // slide 轨迹线
  if (target._trajectoryLine) {
    scene.remove(target._trajectoryLine);
    target._trajectoryLine.geometry.dispose();
    target._trajectoryLine.material.dispose();
  }
  // slide 流动点
  if (target._flowDots) {
    for (const dot of target._flowDots) {
      scene.remove(dot);
      dot.geometry.dispose();
      dot.material.dispose();
    }
  }
  // slide 方向箭头
  if (target._arrows) {
    for (const arrow of target._arrows) {
      scene.remove(arrow);
      arrow.geometry.dispose();
      arrow.material.dispose();
    }
  }
  // 主 mesh
  scene.remove(target.mesh);
  target.mesh.traverse(c => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  });
}

// 单例
export const targetManager = new TargetManager();
