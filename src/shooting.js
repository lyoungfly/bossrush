/**
 * shooting.js — 射线射击检测
 *
 * 从相机向屏幕中心发射射线，
 * 结合 TargetManager 做命中检测 + 节拍判定。
 */

import * as THREE from 'three';
import { camera } from './scene.js';
import { targetManager } from './targets.js';
import { judgeTiming, judgeHit, applyJudgment, applyComboHit, applyComboDestroy, applyTrapHit } from './scoring.js';
import { getSongTime } from './audio.js';

const raycaster = new THREE.Raycaster();

/**
 * 执行一次射击
 *
 * @returns {{
 *   hit: boolean,
 *   target?: Object,
 *   point?: THREE.Vector3,
 *   judgment: 'Perfect' | 'Good' | 'Miss',
 *   comboHit?: boolean,
 *   comboDestroyed?: boolean,
 *   comboRemaining?: number
 * }}
 */
export function shoot() {
  const screenCenter = new THREE.Vector2(0, 0);
  raycaster.setFromCamera(screenCenter, camera);

  const meshes = targetManager.getTargetMeshes();
  const intersects = raycaster.intersectObjects(meshes, true);

  const songTime = getSongTime();

  if (intersects.length > 0) {
    const target = targetManager.getTargetByMesh(intersects[0].object);

    if (!target) {
      applyJudgment('Miss');
      return { hit: false, judgment: 'Miss' };
    }

    const hitPoint = intersects[0].point.clone();

    // ── combo 靶子：多段命中 ──────────────────
    if (target.type === 'combo' && target.hitPoints > 0) {
      // 检查连击节奏：两次点击之间不能超过 COMBO_HIT_INTERVAL
      // （首次点击总是允许）
      const { destroyed, remaining } = targetManager.hitComboTarget(target, songTime);

      if (destroyed) {
        // 最后一击 → 移除靶子 + 击破奖励
        targetManager.removeTarget(target);
        applyComboDestroy();
        return {
          hit: true, target, point: hitPoint,
          judgment: 'Perfect', comboHit: true, comboDestroyed: true, comboRemaining: 0,
        };
      }

      // 非最后击 → 靶子保留，累计分数
      applyComboHit();
      return {
        hit: true, target, point: hitPoint,
        judgment: 'Perfect', comboHit: true, comboDestroyed: false, comboRemaining: remaining,
      };
    }

    // ── trap 靶子：不计分，断连击 ──────────────
    if (target && target.type === 'trap' && !target.isHit) {
      target.isHit = true;
      targetManager.removeTarget(target);
      applyTrapHit();
      return { hit: true, target, point: hitPoint, judgment: 'Miss', _isTrap: true };
    }

    // ── 普通靶子 / 特殊类型：一击即毁 ──────────
    if (target && !target.isHit) {
      target.isHit = true;

      // reaction 靶：仅 Perfect 窗口有效（±25ms），否则 Miss
      let judgment;
      if (target.type === 'reaction') {
        const err = Math.abs(songTime - target.hitTime);
        judgment = err <= 0.045 ? 'Perfect' : 'Miss'; // reaction: ±45ms
        applyJudgment(judgment);
        if (judgment === 'Miss') {
          // reaction 失败不销毁靶子，但扣分
          target.isHit = false; // 允许重试
          return { hit: true, target, point: hitPoint, judgment, _reactionMiss: true };
        }
      } else {
        judgment = judgeHit(songTime, target.hitTime);
        applyJudgment(judgment);
      }

      // explosion: 记录连锁信息
      const explosionChained = target.type === 'explosion'
        ? targetManager._explosionChain(target, songTime) : [];

      targetManager.removeTarget(target);

      // explosion 连锁加分
      if (target.type === 'explosion' && explosionChained.length > 0) {
        for (const _ of explosionChained) {
          applyJudgment('Perfect'); // 每个连锁靶 +300
        }
      }

      return {
        hit: true, target, point: hitPoint, judgment,
        explosionChained: explosionChained.length,
      };
    }
  }

  // 未命中任何靶子
  applyJudgment('Miss');
  return { hit: false, judgment: 'Miss' };
}

export function getRaycaster() {
  return raycaster;
}
