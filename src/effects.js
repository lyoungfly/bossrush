/**
 * effects.js — 命中特效模块
 *
 * EffectManager 负责：
 *   - 生成命中环 / 粒子特效
 *   - 驱动特效生命周期（放大 → 透明 → 移除）
 *   - 不直接操控 UI
 *
 * 用法：
 *   import { effectManager } from './effects.js';
 *   effectManager.spawnHitEffect(position, type);
 *   // 每帧调用
 *   effectManager.update(deltaTime);
 */

import * as THREE from 'three';
import { scene, camera } from './scene.js';

// ═══════════════════════════════════════════════════
// 类型 → 外观配置
// ═══════════════════════════════════════════════════

const TYPE_CFG = {
  normal:    { color: 0x00ffff, ringCount: 1, ringSize: 0.35, particleCount: 0, duration: 0.30 },
  downbeat:  { color: 0xff00ff, ringCount: 3, ringSize: 0.50, particleCount: 8, duration: 0.40 },
  charge:    { color: 0xffff00, ringCount: 2, ringSize: 0.42, particleCount: 4, duration: 0.35 },
  combo:     { color: 0xff8800, ringCount: 1, ringSize: 0.30, particleCount: 3, duration: 0.25 },
  slide:     { color: 0x44ff88, ringCount: 1, ringSize: 0.28, particleCount: 2, duration: 0.22 },
  reaction:  { color: 0xff3333, ringCount: 2, ringSize: 0.35, particleCount: 6, duration: 0.35 },
  explosion: { color: 0xffffff, ringCount: 4, ringSize: 0.60, particleCount: 12, duration: 0.50 },
  trap:      { color: 0x883388, ringCount: 1, ringSize: 0.30, particleCount: 2, duration: 0.25 },
};

// ═══════════════════════════════════════════════════
// EffectManager
// ═══════════════════════════════════════════════════

class EffectManager {
  constructor() {
    /** @type {Array<{ mesh: THREE.Object3D, elapsed: number, duration: number, velocity?: THREE.Vector3 }>} */
    this.effects = [];
  }

  // ── 生成 ─────────────────────────────────────

  /**
   * 在指定位置生成命中特效
   *
   * @param {THREE.Vector3} position - 命中点世界坐标
   * @param {string}        type     - 'normal' | 'downbeat' | 'charge'
   */
  spawnHitEffect(position, type = 'normal') {
    const cfg = TYPE_CFG[type] || TYPE_CFG.normal;

    // ── 扩展环 ────────────────────────────────
    for (let i = 0; i < cfg.ringCount; i++) {
      const ring = this._createRing(position, cfg.color, cfg.ringSize + i * 0.18);
      this.effects.push({
        mesh: ring,
        elapsed: 0,
        duration: cfg.duration + i * 0.04,
      });
    }

    // ── 飞散粒子（downbeat / charge）──────────
    for (let i = 0; i < cfg.particleCount; i++) {
      const particle = this._createParticle(position, cfg.color);
      const dir = new THREE.Vector3(
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 2
      ).normalize();

      const speed = 3 + Math.random() * 5;

      this.effects.push({
        mesh: particle,
        elapsed: 0,
        duration: cfg.duration,
        velocity: dir.multiplyScalar(speed),
      });
    }
  }

  // ── 每帧更新 ────────────────────────────────

  /**
   * 驱动所有特效的生命周期
   *
   * @param {number} dt — delta time (秒)
   */
  update(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.elapsed += dt;
      const t = Math.min(e.elapsed / e.duration, 1); // 0→1

      if (t >= 1) {
        this._dispose(e.mesh);
        this.effects.splice(i, 1);
        continue;
      }

      // 环：放大 + 透明
      if (!e.velocity) {
        const scale = 1 + t * 5;          // 0.3s 内放大到 6x
        e.mesh.scale.setScalar(scale);
      }

      // 粒子：移动 + 透明
      if (e.velocity) {
        e.mesh.position.x += e.velocity.x * dt;
        e.mesh.position.y += e.velocity.y * dt;
        e.mesh.position.z += e.velocity.z * dt;
      }

      // 透明度衰减
      e.mesh.traverse((child) => {
        if (child.material && child.material.opacity !== undefined) {
          child.material.opacity = Math.max(0, 1 - t);
        }
      });
    }
  }

  // ── 内部 ─────────────────────────────────────

  /**
   * 创建一个面向相机的发光环
   */
  _createRing(position, color, size) {
    const geo = new THREE.TorusGeometry(size, 0.04, 16, 32);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.position.copy(position);
    ring.lookAt(camera.position);
    scene.add(ring);
    return ring;
  }

  /**
   * 创建一个发光小球（粒子）
   */
  _createParticle(position, color) {
    const geo = new THREE.SphereGeometry(0.05, 8, 8);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    const particle = new THREE.Mesh(geo, mat);
    particle.position.copy(position);
    scene.add(particle);
    return particle;
  }

  /**
   * 从场景移除 mesh 并释放 GPU 资源
   */
  _dispose(mesh) {
    scene.remove(mesh);
    mesh.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }
  /**
   * 激光命中火花 — 比普通命中更轻量的粒子
   * @param {THREE.Vector3} position
   * @param {number} color - hex color
   */
  spawnLaserSpark(position, color) {
    const geo = new THREE.SphereGeometry(0.03, 6, 6);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const spark = new THREE.Mesh(geo, mat);
    spark.position.copy(position);
    // 微小随机偏移
    spark.position.x += (Math.random() - 0.5) * 0.08;
    spark.position.y += (Math.random() - 0.5) * 0.08;
    scene.add(spark);

    const dir = new THREE.Vector3(
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2,
      (Math.random() - 0.5) * 2
    ).normalize();

    this.effects.push({
      mesh: spark,
      elapsed: 0,
      duration: 0.2,
      velocity: dir.multiplyScalar(2 + Math.random() * 3),
    });
  }

  /**
   * 清空所有特效
   */
  clear() {
    while (this.effects.length > 0) {
      this._dispose(this.effects[0].mesh);
      this.effects.shift();
    }
  }
}

// 单例
export const effectManager = new EffectManager();
