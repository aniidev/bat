
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
        float fade  = pow(1.0 - t, 4.5);   // quadratic ease-out

        // Leading-edge "glow shock" — exponential falloff just behind front
        float front = exp(-behind * 1.2);

        totalGrid  = max(totalGrid,  grid * fade);
        totalFill  = max(totalFill,  fade * 0.19);   // subtle fill between lines
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

// Same sonar grid + pulse logic as the cave shell, but red lattice / shock (obstacles only).
const fragShaderObstacle = /* glsl */`
  #define MAX_P ${MAX_PULSES}

  uniform vec4 uPulses[MAX_P];
  uniform vec3 uCamPos;

  varying vec3 vWorldPos;

  float gridLine(float v, float scale, float lw) {
    float f = fract(v * scale);
    float d = min(f, 1.0 - f);
    return 1.0 - smoothstep(0.0, lw, d);
  }

  void main() {
    const float TRAIL  = 70.0;
    const float GSCALE = 0.75;
    const float LW     = 0.055;

    float lx   = gridLine(vWorldPos.x, GSCALE, LW);
    float ly   = gridLine(vWorldPos.y, GSCALE, LW);
    float lz   = gridLine(vWorldPos.z, GSCALE, LW);
    float grid = max(lx, max(ly, lz));

    float totalGrid  = 0.0;
    float totalFill  = 0.0;
    float totalFront = 0.0;

    for (int i = 0; i < MAX_P; i++) {
      float radius = uPulses[i].w;
      if (radius < 0.0) continue;

      float dist   = distance(vWorldPos, uPulses[i].xyz);
      float behind = radius - dist;

      if (behind > 0.0 && behind < TRAIL) {
        float t     = behind / TRAIL;
        float fade  = (1.0 - t) * (1.0 - t);
        float front = exp(-behind * 0.55);

        totalGrid  = max(totalGrid,  grid * fade);
        totalFill  = max(totalFill,  fade * 0.07);
        totalFront = max(totalFront, front);
      }
    }

    vec3 baseCol  = vec3(0.016, 0.005, 0.005);
    vec3 gridCol  = vec3(1.0,   0.14,  0.06);
    vec3 frontCol = vec3(1.0,   0.52,  0.38);

    vec3 col = baseCol;
    col += gridCol  * (totalGrid * 1.6 + totalFill);
    col += frontCol * (totalFront * totalFront * 3.2);

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

const obstacleCaveMat = new THREE.ShaderMaterial({
  vertexShader:   vertShader,
  fragmentShader: fragShaderObstacle,
  uniforms: {
    uPulses: { value: uPulseVec4 },
    uCamPos: { value: camera.position }
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  CAVE GEOMETRY  (shell: caveMat; props: red lethal OR blue safe, same grid)
// ═══════════════════════════════════════════════════════════════════════
const CAVE_HALF = 38;
const CAVE_H    = 9;

// Player hit sphere (bat body) — tight; colliders match mesh geometry, not loose bounds.
const PLAYER_COLLIDE_R   = 0.44;
const SPAWN_CLEAR_R      = PLAYER_COLLIDE_R + 0.45;
const LETHAL_OVERLAP_EPS = 0.008; // require this much geometric overlap before game over (float noise)

const _capAb = new THREE.Vector3();
const _capAp = new THREE.Vector3();
const _capClosest = new THREE.Vector3();
const _spawnTest = new THREE.Vector3();

function closestPointOnSegment(out, p, a, b) {
  _capAb.subVectors(b, a);
  const lenSq = _capAb.lengthSq();
  if (lenSq < 1e-12) return out.copy(a);
  const t = Math.max(0, Math.min(1, _capAp.subVectors(p, a).dot(_capAb) / lenSq));
  return out.copy(a).addScaledVector(_capAb, t);
}

/** Signed overlap depth along shortest path (positive = intersecting hulls). */
function playerObstacleOverlapDepth(p, c, pr) {
  if (c.type === 'sphere') {
    return pr + c.radius - p.distanceTo(c.center);
  }
  if (c.type === 'capsule') {
    closestPointOnSegment(_capClosest, p, c.a, c.b);
    return pr + c.radius - p.distanceTo(_capClosest);
  }
  return -1e9;
}

function addMesh(geo, mat, pos, rotX, rotY) {
  const m = new THREE.Mesh(geo, mat || caveMat);
  if (pos)  m.position.set(...pos);
  if (rotX) m.rotation.x = rotX;
  if (rotY) m.rotation.y = rotY;
  scene.add(m);
  return m;
}

// ── Noise helpers for organic cave surfaces ───────────────────────
function _cavHash(ix, iz) {
  let s = (ix * 374761393 + iz * 1009) | 0;
  s ^= s << 13; s ^= s >> 17; s ^= s << 5;
  return (s >>> 0) / 4294967296;
}
function _caveNoise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx*fx*(3-2*fx), uz = fz*fz*(3-2*fz);
  const a = _cavHash(ix,   iz  ), b = _cavHash(ix+1, iz  );
  const c = _cavHash(ix,   iz+1), d = _cavHash(ix+1, iz+1);
  return a + (b-a)*ux + (c-a)*uz + (d-b-c+a)*ux*uz;
}
function _caveFbm(x, z, oct) {
  let v=0, amp=0.5, freq=1, tot=0;
  for (let o=0; o<oct; o++) {
    v += _caveNoise2(x*freq, z*freq)*amp;
    tot+=amp; amp*=0.5; freq*=2.1;
  }
  return v/tot;
}
function _displaceZ(geo, fn) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, fn(pos.getX(i), pos.getY(i)));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

// ── Three-scale surface displacement (regional + local + fine) ────
// Regional scale gives dramatic altitude differences across the cave
// (one corner of the floor can be 4–5 m higher than the opposite corner).
function _floorDisp(wx, wz) {
  const reg  = _caveFbm(wx*0.016 + 3.7,  wz*0.016 + 9.1,  2); // whole-cave tilt  (0-1)
  const mid  = _caveFbm(wx*0.058 + 7.3,  wz*0.058 + 2.4,  3); // ridges/bowls     (0-1)
  const fine = _caveFbm(wx*0.22  + 3.7,  wz*0.22  + 9.1,  3); // rocky texture    (0-1)
  return reg * 4.5 + mid * 2.2 + fine * 1.0;   // 0 – 7.7 m above base
}
function _ceilDisp(wx, wz) {
  const reg  = _caveFbm(wx*0.016 + 11.3, wz*0.016 + 5.8,  2);
  const mid  = _caveFbm(wx*0.058 + 15.7, wz*0.058 + 8.2,  3);
  const fine = _caveFbm(wx*0.22  + 11.3, wz*0.22  + 5.8,  3);
  return reg * 4.0 + mid * 1.8 + fine * 0.8;   // 0 – 6.6 m below base
}

function getFloorY(wx, wz) { return -CAVE_H + _floorDisp(wx, wz); }
function getCeilY (wx, wz) { return  CAVE_H - _ceilDisp(wx, wz); }

// Floor (130×130 verts)
const floorGeo = new THREE.PlaneGeometry(CAVE_HALF*2, CAVE_HALF*2, 130, 130);
_displaceZ(floorGeo, (lx, ly) => _floorDisp(lx, -ly));
addMesh(floorGeo, null, [0, -CAVE_H, 0], -Math.PI/2);

// Ceiling (130×130 verts)
const ceilGeo = new THREE.PlaneGeometry(CAVE_HALF*2, CAVE_HALF*2, 130, 130);
_displaceZ(ceilGeo, (lx, ly) => _ceilDisp(lx, ly));
addMesh(ceilGeo, null, [0, CAVE_H, 0], Math.PI/2);

// Walls — anisotropic scalloped displacement (wider freq horizontally, mimicking
// water erosion channels).  Three scales: large rock face → medium scallop → fine surface.
function _rockWallGeo(wS, hS, sx, sz) {
  const geo = new THREE.PlaneGeometry(CAVE_HALF*2, CAVE_H*2, wS, hS);
  _displaceZ(geo, (u, v) => {
    const large   = _caveFbm(u*0.062 + sx,      v*0.045 + sz,      3); // big rock faces
    const scallop = _caveFbm(u*0.21  + sx+5.1,  v*0.32  + sz+5.1,  3); // water scallops (taller than wide)
    const fine    = _caveFbm(u*0.56  + sx+9.3,  v*0.56  + sz+9.3,  2); // fine texture
    return large * 7.0 + scallop * 3.2 + fine * 0.75;
  });
  return geo;
}
addMesh(_rockWallGeo(80, 32, 0.0, 0.0), null, [0, 0, -CAVE_HALF], 0, 0);
addMesh(_rockWallGeo(80, 32, 5.3, 2.1), null, [0, 0,  CAVE_HALF], 0, Math.PI);
addMesh(_rockWallGeo(80, 32, 1.7, 7.4), null, [-CAVE_HALF, 0, 0], 0,  Math.PI/2);
addMesh(_rockWallGeo(80, 32, 9.2, 3.8), null, [ CAVE_HALF, 0, 0], 0, -Math.PI/2);

// Seeded RNG (deterministic layout every time)
const rng = (() => {
  let s = 137;
  return () => { s ^= s<<13; s ^= s>>17; s ^= s<<5; return (s>>>0)/4294967296; };
})();

const obstacleColliders = [];

// ── Shared helper: spawn one stalactite (fromCeil=true) or stalagmite (false) ──
function _spawnTite(x, z, fromCeil, h, baseR, lethal) {
  const tipR = lethal ? 0.015 + rng()*0.03 : 0.03 + rng()*0.09;
  const geo  = new THREE.CylinderGeometry(
    fromCeil ? tipR : baseR,
    fromCeil ? baseR : tipR,
    h, 6
  );
  const m  = new THREE.Mesh(geo, lethal ? obstacleCaveMat : caveMat);
  // Anchor to the actual displaced surface so nothing floats or buries
  const surfY = fromCeil
    ? getCeilY(x, z)  - h * 0.5
    : getFloorY(x, z) + h * 0.5;
  m.position.set(x, surfY, z);
  scene.add(m);
  obstacleColliders.push({
    type: 'capsule',
    a: new THREE.Vector3(x, surfY - h*0.5, z),
    b: new THREE.Vector3(x, surfY + h*0.5, z),
    radius: Math.max(tipR, baseR) * 0.92, lethal
  });
}

// ── DRIP ZONES — the primary speleothem system ────────────────────
// Limestone caves form stalactites where water seeps through cracks.
// Drips fall directly below, growing matching stalagmites.
// Over thousands of years some pairs merge into columns (hourglass shape).
for (let di = 0; di < 9; di++) {
  const zx     = (rng()-0.5) * (CAVE_HALF*2 - 18);
  const zz     = (rng()-0.5) * (CAVE_HALF*2 - 18);
  const spread = 4 + rng() * 10;
  const count  = 4 + Math.floor(rng() * 14);

  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    const rad   = spread * Math.sqrt(rng());  // sqrt = uniform disk distribution
    const x     = Math.max(-CAVE_HALF+2, Math.min(CAVE_HALF-2, zx + Math.cos(angle)*rad));
    const z     = Math.max(-CAVE_HALF+2, Math.min(CAVE_HALF-2, zz + Math.sin(angle)*rad));

    // Stalactite from ceiling — ~55% lethal (pointed spikes are the main danger)
    const h     = 1.4 + rng() * 5.8;
    const base  = 0.06 + rng() * 0.52;
    _spawnTite(x, z, true,  h, base, rng() < 0.55);

    // Matching stalagmite rising below from the drip (~75% form one, ~50% lethal)
    if (rng() > 0.25) {
      const mh = h * (0.3 + rng() * 0.8);
      const mb = base * (0.5 + rng() * 0.9);
      _spawnTite(x + (rng()-0.5)*0.5, z + (rng()-0.5)*0.5, false, mh, mb, rng() < 0.50);
    }
  }

  // 0–2 columns per zone — anchored to actual floor/ceiling surfaces
  const colCount = Math.floor(rng() * 2.6);
  for (let ci = 0; ci < colCount; ci++) {
    const cx    = Math.max(-CAVE_HALF+3, Math.min(CAVE_HALF-3, zx + (rng()-0.5)*spread*0.55));
    const cz    = Math.max(-CAVE_HALF+3, Math.min(CAVE_HALF-3, zz + (rng()-0.5)*spread*0.55));
    const midR  = 0.10 + rng() * 0.28;
    const botR  = midR * (1.7 + rng() * 1.3);
    const topR  = midR * (1.5 + rng() * 1.0);
    const split = 0.35 + rng() * 0.30;

    // Span actual displaced floor → ceiling at this spot
    const colFloorY = getFloorY(cx, cz);
    const colCeilY  = getCeilY(cx, cz);
    const colH      = Math.max(0.5, colCeilY - colFloorY);

    const botH = colH * split;
    const gBot = new THREE.CylinderGeometry(midR, botR, botH, 8);
    const mBot = new THREE.Mesh(gBot, caveMat);
    mBot.position.set(cx, colFloorY + botH*0.5, cz);
    scene.add(mBot);

    const topH = colH * (1 - split);
    const gTop = new THREE.CylinderGeometry(topR, midR, topH, 8);
    const mTop = new THREE.Mesh(gTop, caveMat);
    mTop.position.set(cx, colCeilY - topH*0.5, cz);
    scene.add(mTop);

    obstacleColliders.push({
      type: 'capsule',
      a: new THREE.Vector3(cx, colFloorY, cz),
      b: new THREE.Vector3(cx, colCeilY,  cz),
      radius: Math.max(botR, topR) * 0.88, lethal: false
    });
  }
}

// ── BREAKDOWN FIELDS — collapsed ceiling zones ────────────────────
// Where the cave ceiling has fractured over time, large angular blocks
// pile up on the floor.  Concentrated in 4 zones rather than scattered.
for (let fi = 0; fi < 4; fi++) {
  const bfx    = (rng()-0.5) * (CAVE_HALF*2 - 14);
  const bfz    = (rng()-0.5) * (CAVE_HALF*2 - 14);
  const bcount = 5 + Math.floor(rng() * 10);

  for (let i = 0; i < bcount; i++) {
    const angle = rng() * Math.PI * 2;
    const rad   = rng() * 7;
    const x     = Math.max(-CAVE_HALF+2, Math.min(CAVE_HALF-2, bfx + Math.cos(angle)*rad));
    const z     = Math.max(-CAVE_HALF+2, Math.min(CAVE_HALF-2, bfz + Math.sin(angle)*rad));
    const s     = 0.4 + rng() * 2.8;
    const geo   = rng() > 0.45
      ? new THREE.DodecahedronGeometry(s, 0)
      : new THREE.IcosahedronGeometry(s, 0);
    // Lethal probability scales with sharpness: small shards nearly always lethal
    const lethal = rng() < (s < 0.8 ? 0.85 : s < 1.5 ? 0.55 : 0.25);
    const m  = new THREE.Mesh(geo, lethal ? obstacleCaveMat : caveMat);
    const yB = getFloorY(x, z) + s * 0.52;   // sit on actual displaced floor
    m.position.set(x, yB, z);
    m.rotation.set(rng()*Math.PI, rng()*Math.PI, rng()*Math.PI);
    scene.add(m);
    obstacleColliders.push({
      type: 'sphere',
      center: new THREE.Vector3(x, yB, z),
      radius: s * 0.85, lethal
    });
  }
}

// ── SCATTERED FLOOR BOULDERS ──────────────────────────────────────
for (let i = 0; i < 30; i++) {
  const s = 0.22 + rng() * 1.5;
  const x = (rng()-0.5) * (CAVE_HALF*2 - 4);
  const z = (rng()-0.5) * (CAVE_HALF*2 - 4);
  const lethal = rng() < 0.55;
  const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), lethal ? obstacleCaveMat : caveMat);
  const yB = getFloorY(x, z) + s * 0.55;
  m.position.set(x, yB, z);
  m.rotation.set(rng()*Math.PI, rng()*Math.PI, rng()*Math.PI);
  scene.add(m);
  obstacleColliders.push({
    type: 'sphere',
    center: new THREE.Vector3(x, yB, z),
    radius: s * 0.9, lethal
  });
}

// ── LARGE PILLARS with satellite cluster ─────────────────────────
for (let i = 0; i < 8; i++) {
  const x = (rng()-0.5) * (CAVE_HALF*2 - 16);
  const z = (rng()-0.5) * (CAVE_HALF*2 - 16);
  if (Math.abs(x) < 7 && Math.abs(z) < 7) { i--; continue; }

  const baseR = 1.0 + rng() * 1.8;
  const topR  = baseR * (0.06 + rng() * 0.28);
  const h     = CAVE_H * (1.4 + rng() * 0.6);
  const yC    = -CAVE_H + h * 0.5;
  const geo   = new THREE.CylinderGeometry(topR, baseR, h, 10);
  const m     = new THREE.Mesh(geo, caveMat);
  m.position.set(x, yC, z);
  m.rotation.y = rng() * Math.PI;
  scene.add(m);
  obstacleColliders.push({
    type: 'capsule',
    a: new THREE.Vector3(x, yC - h*0.5, z),
    b: new THREE.Vector3(x, yC + h*0.5, z),
    radius: baseR * 0.88, lethal: false
  });

  const satCount = 3 + Math.floor(rng() * 4);
  for (let k = 0; k < satCount; k++) {
    const ang  = (k / satCount) * Math.PI * 2 + rng() * 0.9;
    const dist = baseR * 1.15 + rng() * 2.8;
    const sx   = x + Math.cos(ang) * dist;
    const sz   = z + Math.sin(ang) * dist;
    const sh   = h * (0.10 + rng() * 0.60);
    const sbr  = baseR * (0.10 + rng() * 0.42);
    const str  = sbr * (0.03 + rng() * 0.22);
    const syC  = -CAVE_H + sh * 0.5;
    const sm   = new THREE.Mesh(new THREE.CylinderGeometry(str, sbr, sh, 7), caveMat);
    sm.position.set(sx, syC, sz);
    sm.rotation.y = rng() * Math.PI;
    scene.add(sm);
    obstacleColliders.push({
      type: 'capsule',
      a: new THREE.Vector3(sx, syC - sh*0.5, sz),
      b: new THREE.Vector3(sx, syC + sh*0.5, sz),
      radius: sbr * 0.88, lethal: false
    });
  }
}

// ── CAVE CURTAINS (drapery) ───────────────────────────────────────
// Thin rippled rock sheets that hang from ceiling overhangs.  In real
// limestone caves these form where water seeps along a sloped surface.
// DoubleSide so they're visible when flying through or around them.
const curtainMat = new THREE.ShaderMaterial({
  vertexShader: vertShader, fragmentShader: fragShader,
  uniforms: { uPulses: { value: uPulseVec4 }, uCamPos: { value: camera.position } },
  side: THREE.DoubleSide
});
for (let i = 0; i < 8; i++) {
  const cx    = (rng()-0.5) * (CAVE_HALF*2 - 12);
  const cz    = (rng()-0.5) * (CAVE_HALF*2 - 12);
  const cw    = 1.8 + rng() * 6.5;
  const ch    = 1.0 + rng() * 4.5;
  const cAng  = rng() * Math.PI;
  const cgeo  = new THREE.PlaneGeometry(cw, ch, Math.max(4, cw*3|0), Math.max(3, ch*3|0));
  // Gentle ripple along the curtain surface
  _displaceZ(cgeo, (u, v) =>
    (_caveNoise2(u*1.3 + cx*0.18 + i*4.1, v*0.85 + cz*0.18) - 0.5) * 0.38
  );
  const cm = new THREE.Mesh(cgeo, curtainMat);
  cm.position.set(cx, CAVE_H - ch*0.5, cz);
  cm.rotation.y = cAng;
  scene.add(cm);
  // Curtains are passable — no collider
}

function findSafeSpawn() {
  function spawnFree(pos, pr) {
    const gap = 0.18;
    for (let i = 0; i < obstacleColliders.length; i++) {
      if (playerObstacleOverlapDepth(pos, obstacleColliders[i], pr) >= -gap) return false;
    }
    return true;
  }
  const rings = [0, 1.8, 3.5, 5.2, 7, 9, 11, 13, 15];
  for (let yi = 0; yi < 12; yi++) {
    const y = -CAVE_H + 2.2 + (yi / 11) * (CAVE_H * 2 - 4.4);
    for (const R of rings) {
      for (let step = 0; step < 24; step++) {
        const a = (step / 24) * Math.PI * 2;
        _spawnTest.set(Math.cos(a) * R, y, Math.sin(a) * R);
        _spawnTest.x = Math.max(-CAVE_HALF + 2.5, Math.min(CAVE_HALF - 2.5, _spawnTest.x));
        _spawnTest.z = Math.max(-CAVE_HALF + 2.5, Math.min(CAVE_HALF - 2.5, _spawnTest.z));
        if (spawnFree(_spawnTest, SPAWN_CLEAR_R)) return _spawnTest.clone();
      }
    }
  }
  return new THREE.Vector3(0, CAVE_H - 3, 0);
}

player.position.copy(findSafeSpawn());

// Cave shell + all grid props — sonar bolts
const sonarRayTargets = [];
scene.traverse((o) => {
  if (!o.isMesh) return;
  if (o.material === caveMat || o.material === obstacleCaveMat || o.material === curtainMat) sonarRayTargets.push(o);
});

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
//  SONAR BOLT + REVERB (crosshair aim → impact drives pulse origin)
// ═══════════════════════════════════════════════════════════════════════
const PULSE_SPEED    = 13;    // world units / second
const PULSE_MAXR     = 120;   // keep data alive until everything has faded
const SONAR_COOLDOWN = 1.4;   // seconds between shots
let   lastSonarTime  = -999;
let   sonarCharge    = 1.0;

const PROJ_SPEED     = 62;
const PROJ_MAX_DIST  = 110;

const raycaster = new THREE.Raycaster();
raycaster.near = 0.02;
raycaster.far  = 220;

const boltGeoms = {
  core: new THREE.IcosahedronGeometry(0.085, 1),
  glow: new THREE.IcosahedronGeometry(0.2, 0),
  tail: new THREE.ConeGeometry(0.055, 0.52, 7, 1, true)
};
const boltMats = {
  core: new THREE.MeshBasicMaterial({ color: 0xaaffff, toneMapped: false }),
  glow: new THREE.MeshBasicMaterial({
    color: 0x0088ff,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false
  }),
  tail: new THREE.MeshBasicMaterial({
    color: 0x55ddff,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false
  })
};

function makeSonarBoltVisual() {
  const g = new THREE.Group();
  const core = new THREE.Mesh(boltGeoms.core, boltMats.core);
  const glow = new THREE.Mesh(boltGeoms.glow, boltMats.glow);
  const tail = new THREE.Mesh(boltGeoms.tail, boltMats.tail);
  tail.rotation.x = Math.PI / 2;
  tail.position.z = 0.32;
  g.add(glow, core, tail);
  return g;
}

// JS-side pulse list  (separate from the uniform slots)
const activePulses = [];       // { origin, radius, rings:[Object3D], ringsDead }
const activeProjectiles = [];  // { mesh, dir: Vector3, traveled }
const impactBursts = [];       // { mesh, mat, geo, t }

const _boltLook = new THREE.Vector3();
const _n = new THREE.Vector3();
const _spawn = new THREE.Vector3();
const _impactBias = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

/** Avoid setFromUnitVectors degeneracy when n ∥ ±Y (floors / ceilings). */
function alignRingGroupToNormal(ringParent, n) {
  if (n.lengthSq() < 1e-10) return;
  _n.copy(n).normalize();
  const d = Math.abs(_yAxis.dot(_n));
  if (d > 0.999) {
    ringParent.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), _n.y > 0 ? 0 : Math.PI);
    return;
  }
  ringParent.quaternion.setFromUnitVectors(_yAxis, _n);
}

const sonarFill = document.getElementById('sonar-fill');
const flashEl   = document.getElementById('flash');

function playLaunchChirp() {
  try {
    const ac  = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const g   = ac.createGain();
    osc.connect(g); g.connect(ac.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(4200, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(900, ac.currentTime + 0.07);
    g.gain.setValueAtTime(0.12, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.09);
    osc.start(); osc.stop(ac.currentTime + 0.1);
  } catch (_) {}
}

function playImpactChirp() {
  try {
    const ac  = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const g   = ac.createGain();
    osc.connect(g); g.connect(ac.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(2100, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(180, ac.currentTime + 0.22);
    g.gain.setValueAtTime(0.2, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.24);
    osc.start(); osc.stop(ac.currentTime + 0.25);
  } catch (_) {}
}

function spawnImpactBurst(pos) {
  const geo = new THREE.SphereGeometry(0.16, 10, 10);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x66ffff,
    transparent: true,
    opacity: 0.72,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  scene.add(mesh);
  impactBursts.push({ mesh, mat, geo, t: 0 });
}

/**
 * @param {THREE.Vector3} origin
 * @param {THREE.Vector3|null} outwardNormal  world-space mesh normal at hit; null = axis-aligned rings
 */
function beginSonarPulse(origin, outwardNormal) {
  const originClone = origin.clone();

  const ringParent = new THREE.Group();
  ringParent.position.copy(originClone);

  if (outwardNormal && outwardNormal.lengthSq() > 1e-8) {
    _n.copy(outwardNormal).normalize();
    ringParent.position.addScaledVector(_n, 0.06);
    alignRingGroupToNormal(ringParent, _n);
  }

  const hRingMat = new THREE.LineBasicMaterial({
    color: 0x44eeff,
    transparent: true,
    opacity: 0.9
  });
  const vRingMat = new THREE.LineBasicMaterial({
    color: 0x00b8ff,
    transparent: true,
    opacity: 0.62
  });
  const hRing = new THREE.Line(ringGeo, hRingMat);
  const vRing = new THREE.Line(ringGeo, vRingMat);
  vRing.rotation.y = Math.PI / 2;
  ringParent.add(hRing, vRing);
  scene.add(ringParent);

  activePulses.push({ origin: originClone, radius: 0.2, rings: [ringParent], ringsDead: false });

  spawnImpactBurst(originClone);

  flashEl.style.opacity = '0.62';
  setTimeout(() => { flashEl.style.opacity = '0'; }, 55);

  playImpactChirp();
}

function fireSonarBolt() {
  if (playerDead) return;
  const now = performance.now() / 1000;
  if (now - lastSonarTime < SONAR_COOLDOWN) return;
  lastSonarTime = now;
  sonarCharge   = 0;

  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const dir = raycaster.ray.direction.clone().normalize();

  _spawn.copy(player.position);
  _spawn.y += 0.38;
  _spawn.addScaledVector(dir, 0.58);

  const mesh = makeSonarBoltVisual();
  mesh.position.copy(_spawn);
  _boltLook.copy(_spawn).add(dir);
  mesh.lookAt(_boltLook);
  scene.add(mesh);

  activeProjectiles.push({ mesh, dir, traveled: 0 });

  flashEl.style.opacity = '0.28';
  setTimeout(() => { flashEl.style.opacity = '0'; }, 40);

  playLaunchChirp();
}

function updateSonarProjectiles(dt) {
  const step = PROJ_SPEED * dt;
  for (let i = activeProjectiles.length - 1; i >= 0; i--) {
    const p = activeProjectiles[i];
    raycaster.set(p.mesh.position, p.dir);
    const prevFar = raycaster.far;
    raycaster.far = step + 0.32;
    const hits = raycaster.intersectObjects(sonarRayTargets, false);
    raycaster.far = prevFar;

    if (hits.length > 0) {
      const h = hits[0];
      _impactBias.copy(h.point);
      let n = null;
      if (h.face) {
        n = _n.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      }
      beginSonarPulse(_impactBias, n);
      scene.remove(p.mesh);
      activeProjectiles.splice(i, 1);
      continue;
    }

    p.mesh.position.addScaledVector(p.dir, step);
    _boltLook.copy(p.mesh.position).add(p.dir);
    p.mesh.lookAt(_boltLook);

    p.traveled += step;
    if (p.traveled >= PROJ_MAX_DIST) {
      beginSonarPulse(p.mesh.position, null);
      scene.remove(p.mesh);
      activeProjectiles.splice(i, 1);
    }
  }
}

function updateImpactBursts(dt) {
  for (let i = impactBursts.length - 1; i >= 0; i--) {
    const b = impactBursts[i];
    b.t += dt;
    const k = b.t / 0.32;
    b.mesh.scale.setScalar(1 + k * 7.5);
    b.mat.opacity = Math.max(0, 0.75 * (1 - k * k));
    if (b.t >= 0.32) {
      scene.remove(b.mesh);
      b.geo.dispose();
      b.mat.dispose();
      impactBursts.splice(i, 1);
    }
  }
}

function clearSonarFX() {
  for (let i = activeProjectiles.length - 1; i >= 0; i--) {
    scene.remove(activeProjectiles[i].mesh);
    activeProjectiles.splice(i, 1);
  }
  for (let i = activePulses.length - 1; i >= 0; i--) {
    const p = activePulses[i];
    p.rings.forEach((r) => {
      scene.remove(r);
      r.traverse((o) => {
        if (o.isLine && o.material) o.material.dispose();
      });
    });
    activePulses.splice(i, 1);
  }
  for (let i = impactBursts.length - 1; i >= 0; i--) {
    const b = impactBursts[i];
    scene.remove(b.mesh);
    b.geo.dispose();
    b.mat.dispose();
    impactBursts.splice(i, 1);
  }
  for (let i = 0; i < MAX_PULSES; i++) uPulseVec4[i].w = -1;
}

// ═══════════════════════════════════════════════════════════════════════
//  INPUT
// ═══════════════════════════════════════════════════════════════════════
const keys = {};
let yaw = 0, pitch = 0, pointerLocked = false, gameStarted = false;
let playerDead = false;

document.addEventListener('keydown', e => { keys[e.code] = true;  });
document.addEventListener('keyup',   e => { keys[e.code] = false; });

function _startGame() {
  if (gameStarted || playerDead) return;
  gameStarted = true;
  document.getElementById('overlay').style.display        = 'none';
  document.getElementById('gameover').style.display       = 'none';
  document.getElementById('ui').style.display             = '';
  document.getElementById('crosshair').style.display      = '';
  document.getElementById('sonar-bar-wrap').style.display = '';
}

document.addEventListener('click', () => {
  if (playerDead) return;
  // Start the game immediately on click — pointer lock is optional (better UX when available).
  _startGame();
  if (!pointerLocked) {
    const req = document.body.requestPointerLock();
    // Modern browsers return a Promise; catch any rejection (file://, browser policy, etc.)
    if (req && typeof req.catch === 'function') req.catch(() => {});
  }
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = !!document.pointerLockElement;
  if (pointerLocked && !playerDead) _startGame();
});

document.getElementById('restart-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!playerDead) return;
  playerDead = false;
  resetRun();
  document.getElementById('gameover').style.display = 'none';
  gameStarted = true;   // keep game running even if pointer lock is unavailable
  const req = document.body.requestPointerLock();
  if (req && typeof req.catch === 'function') req.catch(() => {});
});

document.addEventListener('mousedown', e => {
  if (playerDead || !gameStarted || e.button !== 0) return;
  fireSonarBolt();
});

document.addEventListener('mousemove', e => {
  if (!gameStarted) return;
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

const _sepObs = new THREE.Vector3();

function triggerGameOver() {
  if (playerDead) return;
  playerDead = true;
  clearSonarFX();
  try {
    document.exitPointerLock();
  } catch (_) {}
  pointerLocked = false;
  document.getElementById('gameover').style.display = 'flex';
  document.getElementById('ui').style.display             = 'none';
  document.getElementById('crosshair').style.display    = 'none';
  document.getElementById('sonar-bar-wrap').style.display = 'none';
}

function resetRun() {
  clearSonarFX();
  player.position.copy(findSafeSpawn());
  player.rotation.set(0, 0, 0);
  yaw = 0;
  pitch = 0;
  flapPhase = 0;
  lastSonarTime = -999;
  sonarCharge = 1;
  sonarFill.style.width = '100%';
  Object.keys(keys).forEach((k) => { keys[k] = false; });
}

function resolveObstacleCollisions() {
  const p = player.position;
  const pr = PLAYER_COLLIDE_R;

  for (let i = 0; i < obstacleColliders.length; i++) {
    const c = obstacleColliders[i];
    if (!c.lethal) continue;
    const depth = playerObstacleOverlapDepth(p, c, pr);
    if (depth > LETHAL_OVERLAP_EPS) {
      triggerGameOver();
      return;
    }
  }

  for (let pass = 0; pass < 3; pass++) {
    for (let j = 0; j < obstacleColliders.length; j++) {
      const c = obstacleColliders[j];
      if (c.lethal) continue;
      const depth = playerObstacleOverlapDepth(p, c, pr);
      if (depth <= 0) continue;
      if (c.type === 'sphere') {
        _sepObs.subVectors(p, c.center);
      } else {
        closestPointOnSegment(_capClosest, p, c.a, c.b);
        _sepObs.subVectors(p, _capClosest);
      }
      const len = _sepObs.length();
      if (len < 1e-6) _sepObs.set(0, 1, 0);
      else _sepObs.multiplyScalar(1 / len);
      p.addScaledVector(_sepObs, depth);
    }
  }
}

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
  if (playerDead) return;
  const fast  = keys['ShiftLeft'] || keys['ShiftRight']; //add this later if gameplay boring
  const speed = 10;
  const sinY  = Math.sin(yaw), cosY = Math.cos(yaw);

  let dx = 0, dy = 0, dz = 0;
  if (keys['KeyW'])                       { dx -= sinY;  dz -= cosY;  }
  if (keys['KeyS'])                       { dx += sinY;  dz += cosY;  }
  if (keys['KeyA'])                       { dx -= cosY;  dz += sinY;  }
  if (keys['KeyD'])                       { dx += cosY;  dz -= sinY;  }
  if (keys['KeyQ'] || keys['Space'])        dy += 1;
  if (keys['KeyE'] || keys['ShiftLeft'])  dy -= 1;

  const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if (len > 0) {
    player.position.x += (dx/len) * speed * dt;
    player.position.y += (dy/len) * speed * dt;
    player.position.z += (dz/len) * speed * dt;
  }

  // Wing-flap bob
  flapPhase += dt * (len > 0 ? 5.5 : 2.5);
  player.position.y += Math.sin(flapPhase) * (len > 0 ? 0.014 : 0.006);

  // Clamp to cave bounds (floor/ceiling use displaced surface height)
  player.position.x = Math.max(-CAVE_HALF+1, Math.min(CAVE_HALF-1, player.position.x));
  player.position.z = Math.max(-CAVE_HALF+1, Math.min(CAVE_HALF-1, player.position.z));
  {
    const fY = getFloorY(player.position.x, player.position.z) + PLAYER_COLLIDE_R;
    const cY = getCeilY (player.position.x, player.position.z) - PLAYER_COLLIDE_R;
    player.position.y = Math.max(fY, Math.min(cY, player.position.y));
  }

  resolveObstacleCollisions();
  player.position.x = Math.max(-CAVE_HALF+1, Math.min(CAVE_HALF-1, player.position.x));
  player.position.z = Math.max(-CAVE_HALF+1, Math.min(CAVE_HALF-1, player.position.z));
  {
    const fY = getFloorY(player.position.x, player.position.z) + PLAYER_COLLIDE_R;
    const cY = getCeilY (player.position.x, player.position.z) - PLAYER_COLLIDE_R;
    player.position.y = Math.max(fY, Math.min(cY, player.position.y));
  }

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

  if (gameStarted && !playerDead) updatePlayer(dt);
  updateThirdPersonCamera();

  if (batMixer) batMixer.update(dt);

  // Sonar charge bar
  if (!playerDead) {
    sonarCharge = Math.min(1, sonarCharge + dt / SONAR_COOLDOWN);
    sonarFill.style.width = (sonarCharge * 100).toFixed(1) + '%';
  }

  if (!playerDead) {
    updateSonarProjectiles(dt);
    updateImpactBursts(dt);
  }

  // ── advance pulses ────────────────────────────────────────────────
  for (let i = activePulses.length - 1; i >= 0; i--) {
    const p = activePulses[i];
    p.radius += PULSE_SPEED * dt;

    // Animate the visual rings (first ~1.5s of pulse life)
    if (!p.ringsDead) {
      const rScale  = p.radius;
      const ringLife = 1.0 - p.radius / 28.0;   // fade out by radius 28
      const op = Math.max(0, ringLife * ringLife * 0.8);
      p.rings.forEach((r) => {
        r.scale.setScalar(rScale);
        r.traverse((o) => {
          if (o.isLine && o.material) o.material.opacity = op;
        });
      });
      if (ringLife <= 0) {
        p.rings.forEach((r) => {
          scene.remove(r);
          r.traverse((o) => {
            if (o.isLine && o.material) o.material.dispose();
          });
        });
        p.ringsDead = true;
      }
    }

    // Kill pulse once the trail fully clears the farthest possible surface
    if (p.radius >= PULSE_MAXR) {
      if (!p.ringsDead) {
        p.rings.forEach((r) => {
          scene.remove(r);
          r.traverse((o) => {
            if (o.isLine && o.material) o.material.dispose();
          });
        });
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