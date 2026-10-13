// ProWC 3D viewer. Everything is local (./vendor), no network requests except config/models/posters.
import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/three/loaders/GLTFLoader.js';
import { DRACOLoader } from './vendor/three/loaders/DRACOLoader.js';
import { OrbitControls } from './vendor/three/controls/OrbitControls.js';
import { RoomEnvironment } from './vendor/three/environments/RoomEnvironment.js';
import { RGBELoader } from './vendor/three/loaders/RGBELoader.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.module.js';

const $ = (id) => document.getElementById(id);
const COARSE = matchMedia('(pointer: coarse)').matches;
const MSG_WEBGL = 'Ваш браузер или устройство не поддерживает 3D-графику (WebGL). Попробуйте открыть страницу в другом браузере или на другом устройстве.';
const MSG_MODEL = 'Не удалось загрузить 3D-модель. Проверьте подключение к интернету и попробуйте ещё раз.';
const MSG_LOST = '3D-просмотр был остановлен браузером. Обновите страницу.';

const ICON = {
  roof: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/></svg>',
  door: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 21V3h9v18"/><path d="M14 5l5 2v14l-5-2"/><path d="M3 21h18"/></svg>',
  reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  outside: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>',
  inside: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/></svg>',
};

export async function startViewer(cfg, state, { showError }) {
  const app = $('app');
  const canvas = $('c');

  // ---------- renderer ----------
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    console.warn('WebGL', e);
    showError(MSG_WEBGL);
    return;
  }
  let displayDPR = Math.min(window.devicePixelRatio || 1, COARSE ? 1.5 : 2);
  renderer.setPixelRatio(displayDPR);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); showError(MSG_LOST, () => location.reload()); });

  const scene = new THREE.Scene();
  let model = null; // { root, box, roof[], finishNodes[], variants, doors[], actions[], mod }
  const studioColor = new THREE.Color((cfg.backgrounds && cfg.backgrounds.studio && cfg.backgrounds.studio.color) || '#eceae6');
  scene.background = studioColor;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const studioEnv = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  scene.environment = studioEnv;
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(4, 8, 6);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 200);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.enablePan = false;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.8;
  controls.enabled = false;
  canvas.style.touchAction = ''; // OrbitControls sets 'none'; CSS decides (pan-y until activated)

  // blob shadow: cheap "baked" contact shadow under the module
  const shadowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,0.42)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
  shadow.renderOrder = -1;
  scene.add(shadow);

  // ---------- render on demand ----------
  const clock = new THREE.Clock();
  const prevPos = new THREE.Vector3(), prevTarget = new THREE.Vector3();
  const mixers = [];
  let tween = null; // camera transition
  let running = false;
  let slowFrames = 0;
  function invalidate() {
    if (running) return;
    running = true;
    clock.getDelta();
    requestAnimationFrame(frame);
  }
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.5);
    slowFrames = dt > 0.05 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
    if (slowFrames >= 12 && displayDPR > 0.8) {
      displayDPR = Math.max(0.8, displayDPR * 0.75);
      renderer.setPixelRatio(displayDPR);
      slowFrames = 0;
    }
    let busy = false;
    if (tween) busy = stepTween(dt) || busy;
    for (const m of mixers) m.update(dt);
    if (model && model.actions.some((a) => a.enabled && !a.paused && a.isRunning())) busy = true;
    // damping is per update() call: step it at ~60 Hz so slow devices settle as fast as quick ones
    const steps = Math.min(30, Math.max(1, Math.round(dt * 60)));
    // (update()'s return value is unreliable: target.clampLength() adds float noise every call)
    prevPos.copy(camera.position); prevTarget.copy(controls.target);
    for (let i = 0; i < steps; i++) controls.update();
    if (prevPos.distanceToSquared(camera.position) > 1e-10 || prevTarget.distanceToSquared(controls.target) > 1e-10) busy = true;
    clampCamera();
    renderer.render(scene, camera);
    if (busy) requestAnimationFrame(frame); else running = false;
  }
  controls.addEventListener('change', invalidate);
  controls.addEventListener('start', () => { tween = null; userMoved = true; });

  function resize() {
    const w = app.clientWidth, h = app.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (model && !userMoved && !tween) goView(ui.view, true); // keep the framing when the block/phone rotates
    invalidate();
  }
  let userMoved = false;
  new ResizeObserver(resize).observe(app);
  resize();

  // ---------- interaction gate: never steal page scroll until the user engages ----------
  const hintEl = $('hint');
  let hintTimer = 0;
  function hint(text, ms = 1800) {
    hintEl.textContent = text;
    hintEl.classList.add('is-shown');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hintEl.classList.remove('is-shown'), ms);
  }
  let active = false;
  let idleTimer = 0;
  function setActive(on) {
    if (active === on) return;
    active = on;
    controls.enabled = on;
    app.classList.toggle('is-active', on);
  }
  function bumpIdle() { // on touch devices release the page again after a pause
    if (!COARSE) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!document.fullscreenElement) setActive(false); }, 8000);
  }
  const wheelHint = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Нажмите на модель или используйте ⌘/Ctrl + колесо для масштаба' : 'Нажмите на модель или используйте Ctrl + колесо для масштаба';
  window.addEventListener('wheel', (e) => {
    if (e.target !== canvas) return;
    if (active) return;
    if (e.ctrlKey || e.metaKey) { // pinch on touchpad / Ctrl+wheel: zoom without activating rotation
      controls.enabled = true;
      setTimeout(() => { if (!active) controls.enabled = false; }, 0);
      return;
    }
    e.stopPropagation(); // OrbitControls never sees it -> no preventDefault -> the page scrolls
    hint(wheelHint);
  }, { capture: true, passive: true });

  const touches = new Map(); // pending touch pointers while inactive
  window.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas) return;
    if (active) { bumpIdle(); return; }
    if (e.pointerType === 'mouse' || e.pointerType === 'pen') { setActive(true); return; } // let it through: drag works at once
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp, ev: e }); // event time: a busy main thread must not turn a tap into a long press
    if (touches.size >= 2) { // two fingers: take over immediately
      setActive(true); bumpIdle();
      for (const [id, p] of touches) if (id !== e.pointerId) canvas.dispatchEvent(new PointerEvent('pointerdown', p.ev));
      touches.clear();
      return;
    }
    e.stopPropagation();
  }, { capture: true });
  window.addEventListener('pointerup', (e) => {
    const p = touches.get(e.pointerId);
    if (!p) return;
    touches.delete(e.pointerId);
    if (e.timeStamp - p.t < 600 && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 12) {
      setActive(true); bumpIdle();
      hint('Вращайте модель пальцем, двумя — масштаб');
    }
  }, { capture: true });
  window.addEventListener('pointercancel', (e) => touches.delete(e.pointerId), { capture: true });
  document.documentElement.addEventListener('mouseleave', () => { if (!document.fullscreenElement) setActive(false); });
  window.addEventListener('blur', () => { if (!document.fullscreenElement) setActive(false); });
  new IntersectionObserver((en) => { if (en.some((x) => !x.isIntersecting)) setActive(false); }).observe(app);

  // ---------- model state ----------
  const ui = { finish: state.finish, roof: true, doors: false, bg: state.bg, view: 'outside' };
  const draco = new DRACOLoader().setDecoderPath('./vendor/draco/');
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setDRACOLoader(draco);
  let loadToken = 0;
  let loadedFinish = null;
  let loadedFile = null;

  function disposeModel() {
    if (!model) return;
    scene.remove(model.root);
    model.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) { for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); }
    });
    mixers.length = 0;
    model = null;
  }

  function setProgress(frac) {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    $('loader-fill').style.width = pct + '%';
    $('loader-text').textContent = `Загрузка ${pct} %`;
  }

  async function loadModule(id) {
    const mod = cfg.modules.find((m) => m.id === id);
    const token = ++loadToken;
    const asset = (mod.files && mod.files[ui.finish]) || mod;
    app.classList.add('is-loading');
    app.classList.remove('is-ready');
    $('loader').hidden = false;
    $('error').hidden = true;
    setProgress(0);
    if (mod.poster) { $('poster').src = mod.poster; $('poster').style.visibility = ''; }
    let gltf;
    try {
      gltf = await loader.loadAsync(asset.file, (ev) => {
        const total = ev.lengthComputable && ev.total ? ev.total : asset.bytes;
        if (total) setProgress(Math.min(0.99, ev.loaded / total));
        else $('loader-text').textContent = `Загрузка ${(ev.loaded / 1048576).toFixed(1)} МБ`;
      });
    } catch (e) {
      console.error('model', asset.file, e);
      if (token === loadToken) showError(MSG_MODEL, () => loadModule(id));
      return;
    }
    if (token !== loadToken) return;
    disposeModel();
    if (new URLSearchParams(location.search).get('debug') === '1') {
      const materials = gltf.parser.json.materials || [];
      const suspects = materials.map((mat, i) => ({ name: mat.name || 'material_' + i, pbr: mat.pbrMetallicRoughness || {} }))
        .filter(({ pbr }) => !pbr.baseColorTexture && (!pbr.baseColorFactor || pbr.baseColorFactor.slice(0, 3).every(v => v >= 0.98)))
        .map(({ name }) => name);
      console.warn('GLB white untextured materials (' + mod.id + '):', suspects);
    }
    model = prepareModel(gltf, mod);
    loadedFinish = ui.finish;
    loadedFile = asset.file;
    scene.add(model.root);
    renderer.compile(scene, camera);
    state.module = id;
    applyFinish(ui.finish);
    ui.doors = false; ui.roof = true;
    applyRoof();
    goView('outside', true);
    placeShadow();
    setProgress(1);
    app.classList.remove('is-loading');
    app.classList.add('is-ready');
    $('loader').hidden = true;
    const poster = $('poster');
    setTimeout(() => { if (app.classList.contains('is-ready')) poster.style.visibility = 'hidden'; }, 450);
    buildUI();
    if (state.view && state.view !== 'outside') { goView(state.view); state.view = 'outside'; }
    invalidate();
    // hook for automated checks (test/run.mjs)
    window.__prowc = { ready: true, module: id, finish: () => ui.finish, active: () => active,
      camera: () => camera.position.toArray().concat(controls.target.toArray()), busy: () => running,
      loadedFile: () => loadedFile };
  }

  function prepareModel(gltf, mod) {
    const root = gltf.scene;
    const ext = (gltf.parser.json.extras && gltf.parser.json.extras.prowc) || {};
    const roof = [], finishNodes = [], doorNodes = [];
    root.traverse((o) => {
      const u = o.userData || {};
      if ((u.prowc_role === 'roof' || /ROOF.*(slab|panel)|^Roof$/i.test(o.name)) && !(o.parent && o.parent.userData.prowc_role === 'roof')) roof.push(o);
      if (u.prowc_finish && !(o.parent && o.parent.userData.prowc_finish)) finishNodes.push(o);
      if (u.prowc_door || /^Door_(L|R|\d+)$/i.test(o.name) || /^DoorUnit_[LR]_Pivot_Hinge$/i.test(o.name)) doorNodes.push(o);
      if (o.isMesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) tuneMaterial(m);
      }
    });
    // KHR_materials_variants (per-primitive material swaps)
    const vnames = ((gltf.parser.json.extensions || {}).KHR_materials_variants || {}).variants || [];
    const variantMeshes = [];
    if (vnames.length) root.traverse((o) => {
      const v = o.isMesh && o.userData.gltfExtensions && o.userData.gltfExtensions.KHR_materials_variants;
      if (v) { o.userData.originalMaterial = o.material; variantMeshes.push({ mesh: o, mappings: v.mappings }); }
    });
    const variants = { names: vnames.map((v) => v.name), meshes: variantMeshes, parser: gltf.parser };

    // doors: baked clips "DOOR__<node>" or a simple hinge rotation fallback
    const doors = [];
    const actions = [];
    if (gltf.animations.length) {
      const mixer = new THREE.AnimationMixer(root);
      for (const clip of gltf.animations) {
        if (!/^DOOR__/i.test(clip.name) && gltf.animations.length > 1) continue;
        const a = mixer.clipAction(clip);
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
        actions.push(a);
      }
      mixers.push(mixer);
    }
    root.updateMatrixWorld(true);
    for (const n of doorNodes) {
      const box = new THREE.Box3().setFromObject(n);
      if (box.isEmpty()) continue;
      const clipName = n.userData.prowc_door || ('DOOR__' + n.name);
      const hasClip = actions.some((a) => a.getClip().name === clipName);
      const deg = Number(n.userData.opening_degrees) || ((ext.doors || {})[n.name] || {}).open_deg || 95;
      doors.push({ node: n, box, hasClip, deg, q0: n.quaternion.clone(), t: 0 });
    }

    const box = new THREE.Box3().setFromObject(root);
    return { root, box, roof, finishNodes, variants, doors, actions, mod };
  }

  function tuneMaterial(m) {
    if (!m) return;
    if (m.transmission > 0) { // transmission = extra render pass; plain transparency is enough here
      m.transmission = 0;
      m.transparent = true;
      m.opacity = Math.min(m.opacity, 0.45);
      m.depthWrite = false;
    }
    if (m.map) m.map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    m.envMapIntensity = 1;
  }

  // ---------- actions ----------
  async function applyFinish(id) {
    ui.finish = id;
    if (!model) return;
    if (model.mod.files && loadedFinish !== id) { await loadModule(model.mod.id); return; }
    for (const n of model.finishNodes) n.visible = n.userData.prowc_finish === id;
    const { names, meshes, parser } = model.variants;
    const vi = names.indexOf(id);
    await Promise.all(meshes.map(async ({ mesh, mappings }) => {
      const hit = vi >= 0 && mappings.find((mp) => mp.variants.includes(vi));
      mesh.material = hit ? await parser.getDependency('material', hit.material) : mesh.userData.originalMaterial;
      tuneMaterial(mesh.material);
    }));
    invalidate();
  }

  function applyRoof() {
    if (!model) return;
    for (const n of model.roof) n.visible = ui.roof;
    invalidate();
  }

  function setDoors(open) {
    ui.doors = open;
    if (!model) return;
    for (const a of model.actions) {
      if (!a.isScheduled()) { if (!open) continue; a.reset().play(); }
      a.paused = false;
      a.enabled = true;
      a.timeScale = open ? 1.4 : -1.4;
    }
    for (const d of model.doors) if (!d.hasClip) d.target = open ? 1 : 0;
    if (model.doors.some((d) => !d.hasClip)) animateHinges();
    invalidate();
  }
  function animateHinges() { // fallback: rotate door nodes around their local Y (hinge) axis
    let last = performance.now();
    const step = (now) => {
      const dt = (now - last) / 1000; last = now;
      let moving = false;
      for (const d of model ? model.doors : []) {
        if (d.hasClip || d.target === undefined || d.t === d.target) continue;
        d.t = d.target > d.t ? Math.min(d.target, d.t + dt / 1.2) : Math.max(d.target, d.t - dt / 1.2);
        const e = d.t * d.t * (3 - 2 * d.t);
        d.node.quaternion.copy(d.q0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(d.deg) * e));
        moving = true;
      }
      invalidate();
      if (moving) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  let locationTex = null;
  async function applyBg(kind) {
    ui.bg = kind;
    const loc = cfg.backgrounds && cfg.backgrounds.location;
    if (kind === 'location' && loc && loc.file) {
      try {
        if (!locationTex) {
          locationTex = /\.hdr$/i.test(loc.file) ? await new RGBELoader().loadAsync(loc.file) : await new THREE.TextureLoader().loadAsync(loc.file);
          locationTex.mapping = THREE.EquirectangularReflectionMapping;
          if (!/\.hdr$/i.test(loc.file)) locationTex.colorSpace = THREE.SRGBColorSpace;
        }
        scene.background = locationTex;
        shadow.visible = true;
      } catch (e) {
        console.warn('location', e);
        hint('Не удалось загрузить фон «Локация»');
        ui.bg = 'studio';
      }
    }
    if (ui.bg === 'studio') scene.background = studioColor;
    buildUI();
    invalidate();
  }

  function placeShadow() {
    const b = model.box, s = new THREE.Vector3(), c = new THREE.Vector3();
    b.getSize(s); b.getCenter(c);
    shadow.position.set(c.x, b.min.y + 0.002, c.z);
    shadow.scale.set(s.x * 1.35, 1, s.z * 1.8);
  }

  // ---------- camera views ----------
  const cam = cfg.camera || {};
  function fitDistance(radius) {
    const vfov = THREE.MathUtils.degToRad(35); // outside views always use the default lens
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    return radius / Math.sin(Math.min(vfov, hfov) / 2);
  }
  function views() {
    const b = model.box, size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const mc = model.mod.camera || {};
    const radius = size.length() / 2;
    // aim a little below the centre so the module sits above the bottom toolbar
    const target = mc.target ? new THREE.Vector3().fromArray(mc.target) : c.clone().add(new THREE.Vector3(0, -size.y * 0.1, 0));
    const dir = new THREE.Vector3().fromArray(mc.direction || [0.75, 0.38, 1]).normalize();
    const fit = fitDistance(radius) * (mc.distance || (camera.aspect < 1 ? 1.05 : 1.12));
    const outside = {
      pos: target.clone().addScaledVector(dir, fit), target,
      limits: { minDistance: mc.minDistance || radius * 1.05, maxDistance: Math.max(radius * 4, fit * 1.6), minPolar: 0.15, maxPolar: Math.PI * 0.53, azimuth: null },
    };
    // interior from above (roof removed)
    const floorY = b.min.y + size.y * 0.3;
    const inTarget = new THREE.Vector3(c.x, floorY, c.z);
    const top = {
      pos: new THREE.Vector3(c.x + size.x * 0.05, b.max.y + Math.max(size.x, size.z) * 0.95, c.z + size.z * 0.55), target: inTarget, roof: false,
      limits: { minDistance: size.y * 0.6, maxDistance: radius * 3, minPolar: 0, maxPolar: Math.PI * 0.3, azimuth: null },
    };
    // through the door: in front of the first door, looking in
    let door = null;
    const d = model.doors[0];
    if (d) {
      const db = d.box, dc = db.getCenter(new THREE.Vector3()), ds = db.getSize(new THREE.Vector3());
      const normal = ds.x < ds.z ? new THREE.Vector3(Math.sign(dc.x - c.x) || 1, 0, 0) : new THREE.Vector3(0, 0, Math.sign(dc.z - c.z) || 1);
      const eye = dc.clone(); eye.y = db.min.y + 1.55;
      const lookAt = dc.clone().addScaledVector(normal, -0.9); lookAt.y = db.min.y + 0.6;
      const pos = eye.clone().addScaledVector(normal, 1.9);
      const az = Math.atan2(normal.x, normal.z);
      door = {
        pos, target: lookAt, doors: true, fov: 50,
        limits: { minDistance: 0.6, maxDistance: 3.6, minPolar: Math.PI * 0.25, maxPolar: Math.PI * 0.62, azimuth: [az - 0.6, az + 0.6] },
      };
    }
    return { outside, top, door };
  }
  function applyLimits(l) {
    controls.minDistance = l.minDistance; controls.maxDistance = l.maxDistance;
    controls.minPolarAngle = l.minPolar; controls.maxPolarAngle = l.maxPolar;
    controls.minAzimuthAngle = l.azimuth ? l.azimuth[0] : -Infinity;
    controls.maxAzimuthAngle = l.azimuth ? l.azimuth[1] : Infinity;
  }
  function goView(name, instant) {
    if (!model) return;
    userMoved = false;
    const vs = views();
    const v = vs[name] || vs.outside;
    ui.view = vs[name] ? name : 'outside';
    if (v.roof === false && ui.roof) { ui.roof = false; applyRoof(); }
    if (name === 'outside' && !ui.roof) { ui.roof = true; applyRoof(); }
    if (v.doors && !ui.doors) setDoors(true);
    const fov = v.fov || 35;
    if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    // relax limits during the move, apply after
    applyLimits({ minDistance: 0, maxDistance: Infinity, minPolar: 0, maxPolar: Math.PI, azimuth: null });
    if (instant) {
      camera.position.copy(v.pos); controls.target.copy(v.target); applyLimits(v.limits); controls.update();
      tween = null;
    } else {
      tween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: v.pos, t1: v.target, limits: v.limits };
    }
    buildUI();
    invalidate();
  }
  function stepTween(dt) {
    tween.t = Math.min(1, tween.t + dt / 0.9);
    const e = 1 - Math.pow(1 - tween.t, 3);
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.t0, tween.t1, e);
    if (tween.t >= 1) { applyLimits(tween.limits); tween = null; return false; }
    return true;
  }
  function clampCamera() { // never below the ground
    if (camera.position.y < 0.15) camera.position.y = 0.15;
  }

  // ---------- UI ----------
  const uiEl = $('ui');
  function btn(label, { icon, pressed, onClick, title, iconOnly, cls = '' } = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + (iconOnly ? 'btn--icon ' : '') + cls;
    b.innerHTML = (icon ? ICON[icon] : '') + (iconOnly ? '' : `<span>${label}</span>`);
    b.title = title || label;
    b.setAttribute('aria-label', title || label);
    if (pressed !== undefined) b.setAttribute('aria-pressed', String(!!pressed));
    b.addEventListener('click', onClick);
    return b;
  }
  const sep = () => Object.assign(document.createElement('span'), { className: 'sep' });
  function buildUI() {
    if (!model || state.ui === 'none') return;
    uiEl.textContent = '';
    const full = state.ui === 'full';
    const top = document.createElement('div');
    top.className = 'ui__top';
    if (full && cfg.modules.length > 1) {
      const sel = document.createElement('select');
      sel.className = 'select';
      sel.setAttribute('aria-label', 'Модуль');
      for (const m of cfg.modules) sel.add(new Option(m.label || m.id, m.id, false, m.id === state.module));
      sel.addEventListener('change', () => loadModule(sel.value));
      top.append(sel);
    } else top.append(document.createElement('span'));
    const tr = document.createElement('div');
    tr.className = 'bar';
    tr.append(btn('Сбросить вид', { icon: 'reset', iconOnly: true, onClick: () => goView('outside') }));
    if (document.fullscreenEnabled || document.webkitFullscreenEnabled) tr.append(btn('На весь экран', { icon: 'full', iconOnly: true, onClick: toggleFullscreen }));
    top.append(tr);
    uiEl.append(top);

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fins = model.mod.finishes ? cfg.finishes.filter((f) => model.mod.finishes.includes(f.id)) : cfg.finishes || [];
    if (fins.length > 1) {
      for (const f of fins) bar.append(btn(f.label, { pressed: ui.finish === f.id, onClick: () => { applyFinish(f.id); buildUI(); } }));
    }
    if (full) {
      if (bar.childNodes.length) bar.append(sep());
      if (model.roof.length) bar.append(btn('Крыша', { icon: 'roof', pressed: ui.roof, title: ui.roof ? 'Снять крышу' : 'Вернуть крышу', onClick: () => { ui.roof = !ui.roof; applyRoof(); buildUI(); } }));
      if (model.doors.length || model.actions.length) bar.append(btn('Двери', { icon: 'door', pressed: ui.doors, title: ui.doors ? 'Закрыть двери' : 'Открыть двери', onClick: () => { setDoors(!ui.doors); buildUI(); } }));
      bar.append(sep());
      bar.append(btn('Снаружи', { icon: 'outside', pressed: ui.view === 'outside', onClick: () => goView('outside') }));
      bar.append(btn('Внутри', { icon: 'inside', pressed: ui.view === 'top', title: 'Внутри: вид сверху без крыши', onClick: () => goView('top') }));
      if (model.doors.length) bar.append(btn('Через дверь', { pressed: ui.view === 'door', title: 'Внутри: вид через открытую дверь', onClick: () => goView('door') }));
      const loc = cfg.backgrounds && cfg.backgrounds.location;
      if (loc && loc.file) {
        bar.append(sep());
        bar.append(btn((cfg.backgrounds.studio && cfg.backgrounds.studio.label) || 'Студия', { pressed: ui.bg === 'studio', onClick: () => applyBg('studio') }));
        bar.append(btn(loc.label || 'Локация', { pressed: ui.bg === 'location', onClick: () => applyBg('location') }));
      }
    }
    if (bar.childNodes.length) uiEl.append(bar);
  }
  function toggleFullscreen() {
    const d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else {
      const r = (app.requestFullscreen || app.webkitRequestFullscreen).call(app);
      if (r && r.catch) r.catch(() => hint('Полноэкранный режим недоступен'));
      setActive(true);
    }
  }

  applyBg(ui.bg);
  await loadModule(state.module);
}
