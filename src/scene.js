import * as THREE from 'three';

// ---- 核心对象 ----
let scene;
let camera;
let renderer;
let clock;

// ---- 配置 ----
const CONFIG = {
  bgColor: 0x000000,
  camera: {
    fov: 75,
    near: 0.1,
    far: 1000,
    position: [0, 1.6, 5],
  },
  grid: {
    size: 40,          // 总边长
    divisions: 40,     // 大格线数量（每 1 单位）
    colorMain: 0x00ffff,   // 主网格线：青色
    colorSub: 0x004444,    // 次网格线：暗青
    subDivisions: 5,       // 每个大格细分为 5 小格
  },
  lights: {
    ambient: { color: 0x334466, intensity: 1.2 },
    directional: { color: 0xffffff, intensity: 1.5, position: [8, 12, 4] },
  },
};

/**
 * 创建赛博霓虹风格网格地面
 *
 * 手动构建两组网格线：
 *  - 主网格（亮青）每 1 单位一条
 *  - 次网格（暗青）每 0.2 单位一条
 * 两组线叠加在 y=0 平面上，形成霓虹网格效果。
 */
function createCyberGrid() {
  const { size, divisions, colorMain, colorSub, subDivisions } = CONFIG.grid;
  const half = size / 2;
  const stepMain = size / divisions;               // 1.0
  const stepSub = stepMain / subDivisions;          // 0.2

  const gridGroup = new THREE.Group();

  // ---- 暗色底板（吸收光线，衬托网格发光感）----
  const planeGeo = new THREE.PlaneGeometry(size, size);
  const planeMat = new THREE.MeshStandardMaterial({
    color: 0x050510,
    roughness: 0.9,
    metalness: 0.1,
  });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -0.01;
  plane.receiveShadow = true;
  gridGroup.add(plane);

  // ---- 次网格线（暗青，密集）----
  gridGroup.add(buildGridLines(size, stepSub, colorSub, 0.06));

  // ---- 主网格线（亮青，稀疏）----
  gridGroup.add(buildGridLines(size, stepMain, colorMain, 0.12));

  return gridGroup;
}

/**
 * 构建一组 XY 平面网格线
 * @param {number} size   - 网格总边长
 * @param {number} step   - 线间距
 * @param {number} color  - 线颜色
 * @param {number} opacity - 线不透明度 (0~1)
 * @returns {THREE.LineSegments}
 */
function buildGridLines(size, step, color, opacity) {
  const half = size / 2;
  const points = [];

  // 沿 Z 轴方向的线（平行于 X 轴）
  for (let z = -half; z <= half + 0.001; z += step) {
    points.push(-half, 0, z, half, 0, z);
  }

  // 沿 X 轴方向的线（平行于 Z 轴）
  for (let x = -half; x <= half + 0.001; x += step) {
    points.push(x, 0, -half, x, 0, half);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(points, 3)
  );

  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
  });

  return new THREE.LineSegments(geometry, material);
}

/**
 * 初始化 Three.js 场景、相机、渲染器、时钟
 *
 * @param {HTMLElement} container - 挂载 canvas 的 DOM 节点
 * @returns {{ scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, clock: THREE.Clock }}
 */
export function initScene(container) {
  // ── 场景 ────────────────────────────────────────
  scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.bgColor);

  // ── 相机 ────────────────────────────────────────
  camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    container.clientWidth / container.clientHeight,
    CONFIG.camera.near,
    CONFIG.camera.far
  );
  camera.position.set(...CONFIG.camera.position);
  camera.lookAt(0, 1.6, 0);

  // ── 渲染器 ──────────────────────────────────────
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  // ── 时钟 ────────────────────────────────────────
  clock = new THREE.Clock();

  // ── 光源 ────────────────────────────────────────
  const ambient = new THREE.AmbientLight(
    CONFIG.lights.ambient.color,
    CONFIG.lights.ambient.intensity
  );
  scene.add(ambient);

  const directional = new THREE.DirectionalLight(
    CONFIG.lights.directional.color,
    CONFIG.lights.directional.intensity
  );
  directional.position.set(...CONFIG.lights.directional.position);
  directional.castShadow = true;
  directional.shadow.mapSize.set(1024, 1024);
  directional.shadow.camera.near = 0.5;
  directional.shadow.camera.far = 60;
  directional.shadow.camera.left = -20;
  directional.shadow.camera.right = 20;
  directional.shadow.camera.top = 20;
  directional.shadow.camera.bottom = -20;
  scene.add(directional);

  // ── 赛博霓虹网格地面 ────────────────────────────
  const grid = createCyberGrid();
  _gridGroup = grid;  // 导出引用供动画使用
  scene.add(grid);

  // ── 四角参考柱（空间深度参照）──────────────────
  const pillarGeo = new THREE.CylinderGeometry(0.08, 0.08, 2, 8);
  const pillarMat = new THREE.MeshStandardMaterial({
    color: 0x00ffff,
    emissive: 0x003333,
    roughness: 0.5,
  });
  const half = CONFIG.grid.size / 2;
  [
    [-half, 1, -half],
    [half, 1, -half],
    [-half, 1, half],
    [half, 1, half],
  ].forEach(([x, y, z]) => {
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(x, y, z);
    scene.add(pillar);
  });

  // ── 窗口 resize ────────────────────────────────
  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;

    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  return { scene, camera, renderer, clock };
}

/**
 * 渲染一帧
 */
export function render() {
  renderer.render(scene, camera);
}

// 具名导出，供其他模块引用
let _gridGroup = null;
export function getGridGroup() { return _gridGroup; }

export { scene, camera, renderer, clock };
