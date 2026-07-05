/**
 * player.js — 第一人称鼠标视角控制
 *
 * 基于原生 Pointer Lock API，不依赖 Three.js PointerLockControls。
 *
 * 用法：
 *   import { initPlayerControls, updateCamera } from './player.js';
 *   initPlayerControls(camera, renderer.domElement);
 *   // 在 animate() 中每帧调用 updateCamera()
 */

// ---- 依赖 ----
let camera;         // Three.js PerspectiveCamera 引用
let domElement;     // 触发 pointer lock 的 canvas

// ---- 状态 ----
let isLocked = false;
let gameStarted = false;
let rightMouseDown = false;

// ---- 旋转 ----
let yaw = 0;
let pitch = 0;
const SENSITIVITY = 0.002;
const PITCH_LIMIT = (Math.PI * 85) / 180; // ±85°

// ---- 屏幕震动 ----
let shakeAmount = 0;

/**
 * 触发屏幕震动（downbeat 命中时调用）
 *
 * @param {number} [intensity=0.02] — 震动强度 (弧度)
 */
export function triggerScreenShake(intensity = 0.02) {
  shakeAmount = Math.max(shakeAmount, intensity);
}

// ---- DOM 引用 ----
let startScreen;
let startButton;
let resumeOverlay;

// ═══════════════════════════════════════════════════
// 内部事件处理
// ═══════════════════════════════════════════════════

function onMouseMove(event) {
  if (!isLocked) return;

  yaw -= event.movementX * SENSITIVITY;
  pitch -= event.movementY * SENSITIVITY;

  // 俯仰角限幅
  pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
}

function onPointerLockChange() {
  isLocked = document.pointerLockElement === domElement;

  if (isLocked) {
    // 进入游戏
    gameStarted = true;
    startScreen.style.display = 'none';
    resumeOverlay.style.display = 'none';
  } else if (gameStarted) {
    // 游戏中失去锁定 → 显示恢复提示
    resumeOverlay.style.display = 'flex';
  }
}

function requestLock() {
  domElement.requestPointerLock();
}

// ═══════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════

/**
 * 初始化第一人称视角控制
 *
 * @param {THREE.PerspectiveCamera} cam  - 场景相机
 * @param {HTMLCanvasElement}        dom  - 渲染器绑定的 canvas
 */
export function initPlayerControls(cam, dom) {
  camera = cam;
  domElement = dom;

  // 缓存 DOM 元素
  startScreen = document.getElementById('start-screen');
  startButton = document.getElementById('start-button');
  resumeOverlay = document.getElementById('resume-overlay');

  // ── "START" 按钮 → 请求 pointer lock ──────────
  if (startButton) {
    startButton.addEventListener('click', requestLock);
  }

  // ── 点击恢复遮罩 → 重新锁定 ─────────────────────
  if (resumeOverlay) {
    resumeOverlay.addEventListener('click', requestLock);
  }

  // ── 直接点击 canvas 也可以（方便恢复时快速点击）──
  domElement.addEventListener('click', () => {
    if (!isLocked) {
      requestLock();
    }
  });

  // ── 全局 pointer lock 变化监听 ──────────────────
  document.addEventListener('pointerlockchange', onPointerLockChange);

  // ── 鼠标移动 ────────────────────────────────────
  document.addEventListener('mousemove', onMouseMove);

  // ── 右键激光 ────────────────────────────────────
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('contextmenu', onContextMenu);
}

/**
 * 每帧调用：将 yaw/pitch 应用到 camera.rotation，
 * 并叠加短暂的屏幕震动。
 */
export function updateCamera() {
  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;

  // ── 屏幕震动（加权随机偏移，快速衰减）─────────
  if (shakeAmount > 0.0005) {
    camera.rotation.x += (Math.random() - 0.5) * shakeAmount;
    camera.rotation.y += (Math.random() - 0.5) * shakeAmount;
    shakeAmount *= 0.82; // 约 0.3s 后衰减到可忽略
  } else {
    shakeAmount = 0;
  }
}

// ── 右键激光模式 ────────────────────────────
function onMouseDown(event) {
  if (event.button === 2) {
    rightMouseDown = true;
    event.preventDefault();
  }
}

function onMouseUp(event) {
  if (event.button === 2) {
    rightMouseDown = false;
    event.preventDefault();
  }
}

function onContextMenu(event) {
  event.preventDefault();
}

export function isRightMouseDown() {
  return rightMouseDown;
}

export { isLocked, gameStarted };
