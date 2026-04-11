
// ═══════════════════════════════════════════════════════════════════════
//  RENDERER + SCENE
// ═══════════════════════════════════════════════════════════════════════
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.physicallyCorrectLights = true;
document.body.appendChild(renderer.domElement);

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 200);

// World-space player + bat (third person — camera chases, does not sit on the bat).
const player = new THREE.Group();
player.position.set(0, 0, 0);
scene.add(player);

// Lights for the GLTF bat (cave uses ShaderMaterial and ignores these).
scene.add(new THREE.HemisphereLight(0x4a6a8a, 0x0a0612, 0.45));
const batKey = new THREE.PointLight(0xc8e8ff, 0.85, 22, 2);
batKey.position.set(0, 0.4, 0.15);
player.add(batKey);

let batMixer = null;
const batMount = new THREE.Group();
batMount.rotation.y = Math.PI * 0.5;
player.add(batMount);

new THREE.GLTFLoader().load(
  'scene.gltf',
  (gltf) => {
    const bat = gltf.scene;
    bat.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (let i = 0; i < mats.length; i++) {
        const mat = mats[i];
        if (mat && mat.isMeshStandardMaterial) {
          mat.side = THREE.DoubleSide;
          mat.envMapIntensity = 0.45;
        }
      }
    });
    const box = new THREE.Box3().setFromObject(bat);
    const c = new THREE.Vector3();
    box.getCenter(c);
    bat.position.sub(c);
    const box2 = new THREE.Box3().setFromObject(bat);
    const sz = new THREE.Vector3();
    box2.getSize(sz);
    const mx = Math.max(sz.x, sz.y, sz.z);
    if (mx > 0) bat.scale.setScalar(1.75 / mx);
    batMount.add(bat);
    if (gltf.animations && gltf.animations.length) {
      batMixer = new THREE.AnimationMixer(bat);
      batMixer.clipAction(gltf.animations[0]).play();
    }
  },
  undefined,
  (err) => console.error('scene.gltf load error:', err)
);

// ═══════════════════════════════════════════════════════════════════════
//  ECHOLOCATION SHADER
//  The wave runs entirely in the fragment shader — per-pixel world pos
//  is compared to each pulse origin/radius to determine:
//    • whether this surface pixel is inside the reveal trail
//    • how bright to draw the grid lines
//    • how bright the leading-edge glow is
// ═══════════════════════════════════════════════════════════════════════
const MAX_PULSES = 4;

const vertShader = /* glsl */`
  varying vec3 vWorldPos;
  void main() {
    vec4 wp     = modelMatrix * vec4(position, 1.0);
    vWorldPos   = wp.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragShader = /* glsl */`
  #define MAX_P ${MAX_PULSES}

  // xyz = pulse origin, w = current radius  (-1 = inactive)
  uniform vec4 uPulses[MAX_P];
  uniform vec3 uCamPos;

  varying vec3 vWorldPos;

  // A single grid-line weight: 1 at the cell boundary, 0 in the middle
  float gridLine(float v, float scale, float lw) {
    float f = fract(v * scale);
    float d = min(f, 1.0 - f);          // distance to nearest cell edge (0..0.5)
    return 1.0 - smoothstep(0.0, lw, d);
  }

  void main() {
    // ── grid parameters ──────────────────────────────────────────────
    const float TRAIL  = 70.0;   // world-units of trail behind wavefront
    const float GSCALE = 0.75;   // grid cells per world unit  (1/0.75 ≈ 1.33 m cell)
    const float LW     = 0.055;  // line half-width as fraction of cell

    // 3-D world-space lattice: bright at any integer plane in X, Y, or Z
    float lx   = gridLine(vWorldPos.x, GSCALE, LW);
    float ly   = gridLine(vWorldPos.y, GSCALE, LW);
    float lz   = gridLine(vWorldPos.z, GSCALE, LW);
    float grid = max(lx, max(ly, lz));

    // ── accumulate contributions from all active pulses ───────────────
    float totalGrid  = 0.0;
    float totalFill  = 0.0;
    float totalFront = 0.0;

    for (int i = 0; i < MAX_P; i++) {
      float radius = uPulses[i].w;
      if (radius < 0.0) continue;                // inactive slot

      float dist   = distance(vWorldPos, uPulses[i].xyz);
      float behind = radius - dist;              // >0 means wave has passed here

      if (behind > 0.0 && behind < TRAIL) {
        float t     = behind / TRAIL;            // 0=wavefront  1=trail end
        float fade  = (1.0 - t) * (1.0 - t);   // quadratic ease-out

        // Leading-edge "glow shock" — exponential falloff just behind front
        float front = exp(-behind * 0.55);

        totalGrid  = max(totalGrid,  grid * fade);
        totalFill  = max(totalFill,  fade * 0.07);   // subtle fill between lines
        totalFront = max(totalFront, front);
      }
    }

    // ── compose final colour ─────────────────────────────────────────
    //  base:  near-black cave rock
    //  grid:  deep blue lattice
    //  front: bright cyan shock at wavefront
    vec3 baseCol  = vec3(0.007, 0.007, 0.016);
    vec3 gridCol  = vec3(0.0,   0.42,  1.0);
    vec3 frontCol = vec3(0.45,  0.92,  1.0);

    vec3 col = baseCol;
    col += gridCol  * (totalGrid * 1.6 + totalFill);
    col += frontCol * (totalFront * totalFront * 3.2);   // sharp bright spike

    // ── exponential fog (replaces scene.fog for ShaderMaterial) ──────
    float fogD = distance(vWorldPos, uCamPos);
    float fog  = 1.0 - exp(-fogD * 0.033);
    col = mix(col, vec3(0.0), clamp(fog, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
  }
`;

// Uniform arrays — updated every frame from the JS pulse list
const uPulseVec4 = [];
for (let i = 0; i < MAX_PULSES; i++) uPulseVec4.push(new THREE.Vector4(0, 0, 0, -1));

const caveMat = new THREE.ShaderMaterial({
  vertexShader:   vertShader,
  fragmentShader: fragShader,
  uniforms: {
    uPulses: { value: uPulseVec4 },
    uCamPos: { value: camera.position }   // passed by reference — auto-updates
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  CAVE GEOMETRY  (everything shares caveMat so the shader covers all)
// ═══════════════════════════════════════════════════════════════════════
const CAVE_HALF = 38;
const CAVE_H    = 9;

function addMesh(geo, mat, pos, rotX, rotY) {
  const m = new THREE.Mesh(geo, mat || caveMat);
  if (pos)  m.position.set(...pos);
  if (rotX) m.rotation.x = rotX;
  if (rotY) m.rotation.y = rotY;
  scene.add(m);
  return m;
}

// Floor & ceiling — subdivided so fragments can vary across the surface
addMesh(new THREE.PlaneGeometry(CAVE_HALF*2, CAVE_HALF*2, 40, 40), null, [0, -CAVE_H, 0], -Math.PI/2);
addMesh(new THREE.PlaneGeometry(CAVE_HALF*2, CAVE_HALF*2, 40, 40), null, [0,  CAVE_H, 0],  Math.PI/2);

// Walls
const wallGeo = new THREE.PlaneGeometry(CAVE_HALF*2, CAVE_H*2, 30, 12);
addMesh(wallGeo, null, [0, 0, -CAVE_HALF], 0, 0);
addMesh(wallGeo, null, [0, 0,  CAVE_HALF], 0, Math.PI);
addMesh(wallGeo, null, [-CAVE_HALF, 0, 0], 0,  Math.PI/2);
addMesh(wallGeo, null, [ CAVE_HALF, 0, 0], 0, -Math.PI/2);

// Seeded RNG (deterministic layout every time)
const rng = (() => {
  let s = 137;
  return () => { s ^= s<<13; s ^= s>>17; s ^= s<<5; return (s>>>0)/4294967296; };
})();

// Stalactites & stalagmites
for (let i = 0; i < 90; i++) {
  const x = (rng()-0.5)*(CAVE_HALF*2 - 4);
  const z = (rng()-0.5)*(CAVE_HALF*2 - 4);
  if (Math.abs(x) < 3 && Math.abs(z) < 3) continue;

  const h    = 1.2 + rng() * 5.5;
  const base = 0.08 + rng() * 0.5;
  const top  = rng() > 0.5;   // stalactite from ceiling

  const geo = new THREE.CylinderGeometry(top ? 0.02 : base, top ? base : 0.02, h, 6);
  const m   = new THREE.Mesh(geo, caveMat);
  m.position.set(x, top ? CAVE_H - h*0.5 : -CAVE_H + h*0.5, z);
  scene.add(m);
}

// Boulders / rocks
for (let i = 0; i < 55; i++) {
  const s = 0.25 + rng()*1.9;
  const x = (rng()-0.5)*(CAVE_HALF*2-4);
  const z = (rng()-0.5)*(CAVE_HALF*2-4);
  const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), caveMat);
  m.position.set(x, -CAVE_H + s*0.55, z);
  m.rotation.set(rng()*Math.PI, rng()*Math.PI, rng()*Math.PI);
  scene.add(m);
}

// Mid-air crystal clusters
for (let i = 0; i < 25; i++) {
  const s = 0.15 + rng()*0.7;
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(s, 0), caveMat);
  m.position.set(
    (rng()-0.5)*(CAVE_HALF*2-6),
    (rng()-0.5)*(CAVE_H*1.6),
    (rng()-0.5)*(CAVE_HALF*2-6)
  );
  m.rotation.set(rng()*Math.PI, rng()*Math.PI, rng()*Math.PI);
  scene.add(m);
}

// ═══════════════════════════════════════════════════════════════════════
//  PULSE RING VISUAL
//  A very thin LineLoop circle that expands quickly to give the player
//  immediate feedback that the sound went out.  Separate from the
//  shader effect — exists only for the first ~1.5 seconds of a pulse.
// ═══════════════════════════════════════════════════════════════════════
function makeCircleLine(n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i/n)*Math.PI*2;
    pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}
const ringGeo   = makeCircleLine(72);
const ringGeoV  = makeCircleLine(72);  // vertical ring

// ═══════════════════════════════════════════════════════════════════════
//  SONAR SYSTEM
// ═══════════════════════════════════════════════════════════════════════
const PULSE_SPEED    = 13;    // world units / second
const PULSE_MAXR     = 120;   // keep data alive until everything has faded
const SONAR_COOLDOWN = 1.4;   // seconds between shots
let   lastSonarTime  = -999;
let   sonarCharge    = 1.0;

// JS-side pulse list  (separate from the uniform slots)
const activePulses = [];   // { origin, radius, rings:[] }

const sonarFill = document.getElementById('sonar-fill');
const flashEl   = document.getElementById('flash');

function emitSonar() {
  const now = performance.now() / 1000;
  if (now - lastSonarTime < SONAR_COOLDOWN) return;
  lastSonarTime = now;
  sonarCharge   = 0;

  const origin = player.position.clone();

  // Two visible rings: horizontal (XZ) + one tilted with camera look
  const hRingMat = new THREE.LineBasicMaterial({ color: 0x00bbff, transparent: true, opacity: 0.85 });
  const vRingMat = new THREE.LineBasicMaterial({ color: 0x00bbff, transparent: true, opacity: 0.55 });
  const hRing    = new THREE.Line(ringGeo,  hRingMat);
  const vRing    = new THREE.Line(ringGeoV, vRingMat);
  hRing.position.copy(origin);
  vRing.position.copy(origin);
  vRing.rotation.x = Math.PI / 2;   // vertical ring in XY plane
  scene.add(hRing, vRing);

  activePulses.push({ origin, radius: 0.2, rings: [hRing, vRing], ringsDead: false });

  // Screen flash
  flashEl.style.opacity = '1';
  setTimeout(() => { flashEl.style.opacity = '0'; }, 60);

  // Chirp sound
  try {
    const ac  = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const g   = ac.createGain();
    osc.connect(g); g.connect(ac.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(3400, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(280, ac.currentTime + 0.13);
    g.gain.setValueAtTime(0.22, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.15);
    osc.start(); osc.stop(ac.currentTime + 0.16);
  } catch(_) {}
}

// ═══════════════════════════════════════════════════════════════════════
//  INPUT
// ═══════════════════════════════════════════════════════════════════════
const keys = {};
let yaw = 0, pitch = 0, pointerLocked = false, gameStarted = false;

document.addEventListener('keydown', e => { keys[e.code] = true;  });
document.addEventListener('keyup',   e => { keys[e.code] = false; });

document.addEventListener('click', () => {
  if (!pointerLocked) document.body.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = !!document.pointerLockElement;
  if (pointerLocked && !gameStarted) {
    gameStarted = true;
    document.getElementById('overlay').style.display        = 'none';
    document.getElementById('ui').style.display             = '';
    document.getElementById('crosshair').style.display      = '';
    document.getElementById('sonar-bar-wrap').style.display = '';
  }
});

document.addEventListener('mousedown', e => { if (pointerLocked && e.button === 0) emitSonar(); });

document.addEventListener('mousemove', e => {
  if (!pointerLocked) return;
  yaw   -= e.movementX * 0.0022;
  pitch -= e.movementY * 0.0022;
  pitch  = Math.max(-Math.PI*0.47, Math.min(Math.PI*0.47, pitch));
});

// ═══════════════════════════════════════════════════════════════════════
//  MOVEMENT
// ═══════════════════════════════════════════════════════════════════════
const clock = new THREE.Clock();
let flapPhase = 0;

const _camEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _camForward = new THREE.Vector3();
const _camLook = new THREE.Vector3();
const CAM_DIST = 6.2;
const CAM_HEIGHT = 1.35;
const CAM_LOOK_AHEAD = 1.35;

function updateThirdPersonCamera() {
  _camEuler.set(pitch, yaw, 0);
  _camForward.set(0, 0, -1).applyEuler(_camEuler);
  camera.position.copy(player.position).addScaledVector(_camForward, -CAM_DIST);
  camera.position.y += CAM_HEIGHT;
  _camLook.copy(player.position).addScaledVector(_camForward, CAM_LOOK_AHEAD);
  _camLook.y += 0.42;
  camera.up.set(0, 1, 0);
  camera.lookAt(_camLook);
}

function updatePlayer(dt) {
  const fast  = keys['ShiftLeft'] || keys['ShiftRight'];
  const speed = fast ? 15 : 8;
  const sinY  = Math.sin(yaw), cosY = Math.cos(yaw);

  let dx = 0, dy = 0, dz = 0;
  if (keys['KeyW'])                       { dx -= sinY;  dz -= cosY;  }
  if (keys['KeyS'])                       { dx += sinY;  dz += cosY;  }
  if (keys['KeyA'])                       { dx -= cosY;  dz += sinY;  }
  if (keys['KeyD'])                       { dx += cosY;  dz -= sinY;  }
  if (keys['KeyQ'] || keys['Space'])        dy += 1;
  if (keys['KeyE'] || keys['ControlLeft'])  dy -= 1;

  const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if (len > 0) {
    player.position.x += (dx/len) * speed * dt;
    player.position.y += (dy/len) * speed * dt;
    player.position.z += (dz/len) * speed * dt;
  }

  // Wing-flap bob
  flapPhase += dt * (len > 0 ? 5.5 : 2.5);
  player.position.y += Math.sin(flapPhase) * (len > 0 ? 0.014 : 0.006);

  // Clamp to cave bounds
  player.position.x = Math.max(-CAVE_HALF+1, Math.min(CAVE_HALF-1, player.position.x));
  player.position.y = Math.max(-CAVE_H+1,    Math.min(CAVE_H-1,    player.position.y));
  player.position.z = Math.max(-CAVE_HALF+1, Math.min(CAVE_HALF-1, player.position.z));

  player.rotation.order = 'YXZ';
  player.rotation.y = yaw;
  player.rotation.x = pitch * 0.22;
}

// ═══════════════════════════════════════════════════════════════════════
//  ANIMATE LOOP
// ═══════════════════════════════════════════════════════════════════════
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (gameStarted) updatePlayer(dt);
  updateThirdPersonCamera();

  if (batMixer) batMixer.update(dt);

  // Sonar charge bar
  sonarCharge = Math.min(1, sonarCharge + dt / SONAR_COOLDOWN);
  sonarFill.style.width = (sonarCharge * 100).toFixed(1) + '%';

  // ── advance pulses ────────────────────────────────────────────────
  for (let i = activePulses.length - 1; i >= 0; i--) {
    const p = activePulses[i];
    p.radius += PULSE_SPEED * dt;

    // Animate the visual rings (first ~1.5s of pulse life)
    if (!p.ringsDead) {
      const rScale  = p.radius;
      const ringLife = 1.0 - p.radius / 28.0;   // fade out by radius 28
      p.rings.forEach(r => {
        r.scale.setScalar(rScale);
        r.material.opacity = Math.max(0, ringLife * ringLife * 0.8);
      });
      if (ringLife <= 0) {
        p.rings.forEach(r => { scene.remove(r); r.material.dispose(); });
        p.ringsDead = true;
      }
    }

    // Kill pulse once the trail fully clears the farthest possible surface
    if (p.radius >= PULSE_MAXR) {
      if (!p.ringsDead) {
        p.rings.forEach(r => { scene.remove(r); r.material.dispose(); });
      }
      activePulses.splice(i, 1);
    }
  }

  // ── sync to shader uniforms ───────────────────────────────────────
  // Pack up to MAX_PULSES active pulses into the vec4 array.
  // Older pulses beyond MAX_PULSES slots are dropped (they're far-trail anyway).
  for (let i = 0; i < MAX_PULSES; i++) {
    const p = activePulses[i];
    if (p) {
      uPulseVec4[i].set(p.origin.x, p.origin.y, p.origin.z, p.radius);
    } else {
      uPulseVec4[i].w = -1;   // mark slot inactive
    }
  }
  // uCamPos is a reference to camera.position — no manual update needed

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

animate();