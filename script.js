
// ═══════════════════════════════════════════════════════════════════════
//  RENDERER + SCENE
// ═══════════════════════════════════════════════════════════════════════


const Pathfinding = window.threePathfinding.Pathfinding;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.physicallyCorrectLights = true;
document.body.appendChild(renderer.domElement);

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 360);

// World-space player + bat (third person — camera chases, does not sit on the bat).
const player = new THREE.Group();
player.position.set(0, 0, 0);
scene.add(player);

// Lights for GLTF creatures (MeshStandardMaterial). Cave ShaderMaterials ignore these.
// Ambient + hemisphere = minimum fill so PBR models are never a black silhouette (tutorial pattern).
scene.add(new THREE.AmbientLight(0x8899b0, 0.42));
scene.add(new THREE.HemisphereLight(0x5c7090, 0x121018, 0.58));
const batKey = new THREE.PointLight(0xc8e8ff, 0.85, 22, 2);
batKey.position.set(0, 0.4, 0.15);
player.add(batKey);

let batMixer = null;
const batMount = new THREE.Group();
batMount.rotation.y = Math.PI * 0.5;
player.add(batMount);


let navmesh;
const pathfinding = new Pathfinding();
const ZONE = 'level1';
const loader = new THREE.GLTFLoader();
loader.load('scene.gltf', ({scene}) => {
    scene.traverse((node) => {
        if (node.isMesh) navmesh = node;
    });
    pathfinding.setZoneData(ZONE, Pathfinding.createZone(navmesh.geometry));
}, undefined, (e) => {
    console.error(e);
});

/** Same PBR + centering + scale for bat, eagles, and any other GLTF creature. */
function configureGltfCreature(root, maxAxisSize) {
  root.traverse((o) => {
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
  const box = new THREE.Box3().setFromObject(root);
  const c = new THREE.Vector3();
  const sz = new THREE.Vector3();
  box.getCenter(c);
  box.getSize(sz);
  const mx = Math.max(sz.x, sz.y, sz.z);
  if (mx > 0) {
    const s = maxAxisSize / mx;
    root.scale.setScalar(s);
    // Position must account for scale: parent_center = position + scale * geometry_center = 0
    root.position.set(-c.x * s, -c.y * s, -c.z * s);
  }
}

/** Eagle GLTF: scale/center the mesh, then swap every sub-mesh to the sonar material. */
function configureEagleGltf(root) {
  configureGltfCreature(root, 2.8);
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material = hawkMat;   // invisible until a sonar pulse illuminates it
  });
}

new THREE.GLTFLoader().load(
  'scene.gltf',
  (gltf) => {
    const bat = gltf.scene;
    configureGltfCreature(bat, 1.75);
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

// Gold exit shader — same grid/pulse logic, warm amber/gold palette
const fragShaderExit = /* glsl */`
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
    const float TRAIL  = 80.0;
    const float GSCALE = 0.65;
    const float LW     = 0.07;

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
        float fade  = pow(1.0 - t, 3.5);
        float front = exp(-behind * 0.9);
        totalGrid  = max(totalGrid,  grid * fade);
        totalFill  = max(totalFill,  fade * 0.22);
        totalFront = max(totalFront, front);
      }
    }

    // Gold/amber palette — hidden until sonar, same as all cave geometry
    vec3 baseCol  = vec3(0.007, 0.005, 0.0);
    vec3 gridCol  = vec3(1.0,  0.72, 0.08);
    vec3 frontCol = vec3(1.0,  0.96, 0.55);

    vec3 col = baseCol + gridCol * (totalGrid * 1.8 + totalFill);
    col += frontCol * (totalFront * totalFront * 3.5);

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

const exitMat = new THREE.ShaderMaterial({
  vertexShader:   vertShader,
  fragmentShader: fragShaderExit,
  side: THREE.BackSide,
  uniforms: {
    uPulses: { value: uPulseVec4 },
    uCamPos: { value: camera.position }
  }
});
const exitRingMat = new THREE.ShaderMaterial({
  vertexShader:   vertShader,
  fragmentShader: fragShaderExit,
  side: THREE.DoubleSide,
  depthWrite: true,
  polygonOffset: true,
  polygonOffsetFactor: -2.5,
  polygonOffsetUnits: -2.5,
  uniforms: {
    uPulses: { value: uPulseVec4 },
    uCamPos: { value: camera.position }
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  CAVE GEOMETRY  (shell: caveMat; props: red lethal OR blue safe, same grid)
// ═══════════════════════════════════════════════════════════════════════
const CAVE_HALF = 56;
const CAVE_H    = 14;

// Exit hole — radius/depth are fixed; center + orientation are chosen at runtime
const EXIT_RADIUS =   2.85;
const EXIT_DEPTH  =  12;
let exitCenter    = new THREE.Vector3(9999, 9999, 9999);  // set when geometry is built
let exitIsFloor   = false;   // true → floor hole, false → wall / ceiling hole
const exitAnchor  = new THREE.Vector3(9999, 9999, 9999);  // surface point at hole center
const exitNormal  = new THREE.Vector3(0, 1, 0);           // tunnel extends from anchor along +exitNormal
/** @type {'floor' | 'ceiling' | 'wall'} */
let exitKind = 'wall';
// Win volume: in-plane hole + depth along tunnel (matches gold rim / black fill, not a 3D ball at exitCenter)
const EXIT_WIN_HOLE_R    = EXIT_RADIUS * 1.34;
const EXIT_WIN_ALONG_MIN = 0.26;
const EXIT_WIN_ALONG_MAX = EXIT_DEPTH * 0.62;

// Player hit sphere (bat body) — tight; colliders match mesh geometry, not loose bounds.
const PLAYER_COLLIDE_R   = 0.44;
const SPAWN_CLEAR_R      = PLAYER_COLLIDE_R + 0.45;
const LETHAL_OVERLAP_EPS = 0.008; // require this much geometric overlap before game over (float noise)

const _capAb = new THREE.Vector3();
const _capAp = new THREE.Vector3();
const _capClosest = new THREE.Vector3();
const _spawnTest = new THREE.Vector3();
const _exitRel = new THREE.Vector3();
const _exitWinPos = new THREE.Vector3();

/** Wall exit: relax slab constraint when player is aligned with the hole (same frame as geometry). */
function exitWallReliefActiveAt(px, py, pz, pr) {
  if (exitKind !== 'wall') return false;
  _exitRel.set(px, py, pz).sub(exitAnchor);
  const along = _exitRel.dot(exitNormal);
  _exitRel.addScaledVector(exitNormal, -along);
  if (_exitRel.length() > EXIT_RADIUS * 1.45 + pr) return false;
  if (along < -0.85 || along > EXIT_DEPTH * 0.82) return false;
  return true;
}

/** True when bat body centre is inside the irregular hole disc and far enough along the tunnel axis. */
function playerInExitWinVolume(px, py, pz) {
  _exitRel.set(px, py, pz).sub(exitAnchor);
  const along = _exitRel.dot(exitNormal);
  _exitRel.addScaledVector(exitNormal, -along);
  if (_exitRel.length() > EXIT_WIN_HOLE_R) return false;
  if (along < EXIT_WIN_ALONG_MIN || along > EXIT_WIN_ALONG_MAX) return false;
  return true;
}

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
// Slightly gentler amplitudes so floor/ceiling read as one continuous chamber
// instead of unrelated “lumpy patches.”
function _floorDisp(wx, wz) {
  const reg  = _caveFbm(wx*0.014 + 3.7,  wz*0.014 + 9.1,  2);
  const mid  = _caveFbm(wx*0.052 + 7.3,  wz*0.052 + 2.4,  3);
  const fine = _caveFbm(wx*0.20  + 3.7,  wz*0.20  + 9.1,  3);
  return reg * 3.7 + mid * 1.9 + fine * 0.9;
}
function _ceilDisp(wx, wz) {
  const reg  = _caveFbm(wx*0.014 + 11.3, wz*0.014 + 5.8,  2);
  const mid  = _caveFbm(wx*0.052 + 15.7, wz*0.052 + 8.2,  3);
  const fine = _caveFbm(wx*0.20  + 11.3, wz*0.20  + 5.8,  3);
  return reg * 3.3 + mid * 1.55 + fine * 0.65;
}

function getFloorY(wx, wz) { return -CAVE_H + _floorDisp(wx, wz); }
function getCeilY (wx, wz) { return  CAVE_H - _ceilDisp(wx, wz); }

/** Same displacement as _rockWallGeo — used to clamp the player so the sphere stays inside the visible rock shell. */
function _wallRockDisp(u, v, sx, sz) {
  const large   = _caveFbm(u * 0.056 + sx,      v * 0.042 + sz,      3);
  const scallop = _caveFbm(u * 0.19  + sx + 5.1, v * 0.30  + sz + 5.1,  3);
  const fine    = _caveFbm(u * 0.52  + sx + 9.3, v * 0.52  + sz + 9.3,  2);
  return large * 6.2 + scallop * 2.85 + fine * 0.7;
}

/**
 * Keep player sphere inside the four displaced walls (fixes clipping through sides).
 * Derived from the same local (u,v) → displacement as the wall PlaneGeometry meshes.
 */
function constrainPlayerToWallShell(pos, r) {
  const px = pos.x;
  const py = pos.y;
  const pz = pos.z;
  // North z−, south z+, west x−, east x+ — inner cave is the region *inside* each slab.
  const zMin = -CAVE_HALF + _wallRockDisp(px, py, 0.0, 0.0) + r;
  const zMax = CAVE_HALF - _wallRockDisp(-px, py, 5.3, 2.1) - r;
  const xMin = -CAVE_HALF + _wallRockDisp(-pz, py, 1.7, 7.4) + r;
  const xMax = CAVE_HALF - _wallRockDisp(pz, py, 9.2, 3.8) - r;
  const relief = exitWallReliefActiveAt(px, py, pz, r);
  if (!(relief && exitNormal.z > 0.55) && pz < zMin) pos.z = zMin;
  if (!(relief && exitNormal.z < -0.55) && pz > zMax) pos.z = zMax;
  if (!(relief && exitNormal.x > 0.55) && px < xMin) pos.x = xMin;
  if (!(relief && exitNormal.x < -0.55) && px > xMax) pos.x = xMax;
}

function clampPointToFloorCeiling(pos, r) {
  const cY = getCeilY(pos.x, pos.z) - r;
  let inCeilingExit = false;
  if (exitKind === 'ceiling') {
    const exDx = pos.x - exitAnchor.x;
    const exDz = pos.z - exitAnchor.z;
    inCeilingExit = (exDx * exDx + exDz * exDz) < EXIT_RADIUS * EXIT_RADIUS;
  }
  if (!inCeilingExit && pos.y > cY) { pos.y = cY; return; }
  // If the exit is a floor hole, punch out the floor so the player can enter it
  let inExit = false;
  if (exitIsFloor) {
    const exDx = pos.x - exitCenter.x;
    const exDz = pos.z - exitCenter.z;
    inExit = (exDx * exDx + exDz * exDz) < EXIT_RADIUS * EXIT_RADIUS;
  }
  if (!inExit) {
    const fY = getFloorY(pos.x, pos.z) + r;
    if (pos.y < fY) pos.y = fY;
  }
}

/** Used for camera & spawn checks — same bounds as player shell, smaller clearance. */
function isPointInsideCaveShell(px, py, pz, r) {
  const zMin = -CAVE_HALF + _wallRockDisp(px, py, 0.0, 0.0) + r;
  const zMax = CAVE_HALF - _wallRockDisp(-px, py, 5.3, 2.1) - r;
  const xMin = -CAVE_HALF + _wallRockDisp(-pz, py, 1.7, 7.4) + r;
  const xMax = CAVE_HALF - _wallRockDisp(pz, py, 9.2, 3.8) - r;
  const fY = getFloorY(px, pz) + r;
  const cY = getCeilY(px, pz) - r;
  const inWalls =
    px >= xMin - 1e-4 &&
    px <= xMax + 1e-4 &&
    pz >= zMin - 1e-4 &&
    pz <= zMax + 1e-4;
  const inY = py >= fY - 1e-4 && py <= cY + 1e-4;
  if (inWalls && inY) return true;
  const dxF = px - exitAnchor.x;
  const dzF = pz - exitAnchor.z;
  const disc = dxF * dxF + dzF * dzF < EXIT_RADIUS * EXIT_RADIUS;
  if (exitKind === 'floor' && disc && inWalls) {
    if (py >= fY - EXIT_DEPTH * 0.72 && py <= cY + 2.0) return true;
  }
  if (exitKind === 'ceiling' && disc && inWalls) {
    if (py <= cY + EXIT_DEPTH * 0.72 && py >= fY - 2.0) return true;
  }
  if (exitKind === 'wall' && exitWallReliefActiveAt(px, py, pz, r)) {
    const pad = 2.5;
    return (
      px >= xMin - pad &&
      px <= xMax + pad &&
      pz >= zMin - pad &&
      pz <= zMax + pad &&
      py >= fY - 3.0 &&
      py <= cY + 3.0
    );
  }
  return false;
}

function snapPointIntoCaveShell(pos, r) {
  for (let i = 0; i < 10; i++) {
    constrainPlayerToWallShell(pos, r);
    clampPointToFloorCeiling(pos, r);
  }
}

// Floor (150×150 verts)
const floorGeo = new THREE.PlaneGeometry(CAVE_HALF*2, CAVE_HALF*2, 150, 150);
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
  _displaceZ(geo, (u, v) => _wallRockDisp(u, v, sx, sz));
  return geo;
}
addMesh(_rockWallGeo(88, 36, 0.0, 0.0), null, [0, 0, -CAVE_HALF], 0, 0);
addMesh(_rockWallGeo(88, 36, 5.3, 2.1), null, [0, 0,  CAVE_HALF], 0, Math.PI);
addMesh(_rockWallGeo(88, 36, 1.7, 7.4), null, [-CAVE_HALF, 0, 0], 0,  Math.PI/2);
addMesh(_rockWallGeo(88, 36, 9.2, 3.8), null, [ CAVE_HALF, 0, 0], 0, -Math.PI/2);

// Seeded RNG (deterministic layout every time)
const rng = (() => {
  let s = 137;
  return () => { s ^= s<<13; s ^= s>>17; s ^= s<<5; return (s>>>0)/4294967296; };
})();

const obstacleColliders = [];

/** 0 = open gallery center, 1 = near perimeter — one coherent fly space, danger on the rim. */
function galleryEdge01(x, z) {
  const nx = x / CAVE_HALF;
  const nz = z / CAVE_HALF;
  return Math.min(1, Math.sqrt(nx * nx + nz * nz) * 1.12);
}

// ── Shared helper: classic drip cylinder ───────────────────────────
function _spawnTite(x, z, fromCeil, h, baseR, lethal) {
  const tipR = lethal ? 0.015 + rng()*0.03 : 0.03 + rng()*0.09;
  // Cylinder: radiusTop at +Y, radiusBottom at −Y. Ceiling: wide at top, tip down; floor: wide at bottom.
  const geo  = new THREE.CylinderGeometry(
    fromCeil ? baseR : tipR,
    fromCeil ? tipR : baseR,
    h, 6
  );
  const m  = new THREE.Mesh(geo, lethal ? obstacleCaveMat : caveMat);
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

/** Sharp icicle / soda-straw cone hanging from ceiling — collider as thin capsule. */
function _spawnCeilingCone(x, z, h, baseR, lethal) {
  const seg = 5 + (rng() * 4) | 0;
  const geo = new THREE.ConeGeometry(baseR, h, seg);
  // Default cone: tip at +Y, base at −Y — rotate so base meets ceiling and tip points down.
  geo.rotateX(Math.PI);
  const m = new THREE.Mesh(geo, lethal ? obstacleCaveMat : caveMat);
  const topY = getCeilY(x, z);

  m.position.set(x, topY - h * 0.5, z);

  scene.add(m);

  const rad = Math.max(0.04, baseR * 0.55);
  obstacleColliders.push({
    type: 'capsule',
    a: new THREE.Vector3(x, topY - h * 0.08, z),
    b: new THREE.Vector3(x, topY - h * 0.92, z),
    radius: rad * (lethal ? 0.95 : 1.05),
    lethal
  });
}

/** Broken fracture block or chert nodule — box / tetra / octa. */
function _spawnPolyRock(x, z, yCenter, sx, sy, sz, lethal, kind) {
  let geo;
  if (kind === 0) {
    geo = new THREE.BoxGeometry(sx, sy, sz);
  } else if (kind === 1) {
    const t = (sx + sy + sz) / 3;
    geo = new THREE.TetrahedronGeometry(t * 0.92, 0);
  } else if (kind === 2) {
    const t = (sx + sy + sz) / 3;
    geo = new THREE.OctahedronGeometry(t * 0.88, 0);
  } else {
    geo = new THREE.DodecahedronGeometry((sx + sy + sz) / 3 * 0.45, 0);
  }
  const m = new THREE.Mesh(geo, lethal ? obstacleCaveMat : caveMat);
  m.position.set(x, yCenter, z);
  m.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
  scene.add(m);
  const rr = Math.max(sx, sy, sz) * 0.42;
  obstacleColliders.push({
    type: 'sphere',
    center: new THREE.Vector3(x, yCenter, z),
    radius: rr * (kind === 0 ? 0.75 : 0.88),
    lethal
  });
}

/** Ceiling: varied drip shapes — cones, frusta, prisms — reads as natural cave, not one repeated mesh. */
function _spawnCeilingVariety(x, z, lethal) {
  const roll = rng();
  const h = 1.35 + rng() * 5.4;
  const base = 0.07 + rng() * 0.5;
  if (roll < 0.34) {
    _spawnTite(x, z, true, h, base, lethal);
  } else if (roll < 0.58) {
    _spawnCeilingCone(x, z, h, base * (1.1 + rng() * 1.4), lethal);
  } else if (roll < 0.78) {
    const geo = new THREE.CylinderGeometry(base * 1.05, base * 0.22, h, 6);
    const m = new THREE.Mesh(geo, lethal ? obstacleCaveMat : caveMat);
    const surfY = getCeilY(x, z) - h * 0.5;
    m.position.set(x, surfY, z);
    scene.add(m);
    obstacleColliders.push({
      type: 'capsule',
      a: new THREE.Vector3(x, surfY - h * 0.5, z),
      b: new THREE.Vector3(x, surfY + h * 0.5, z),
      radius: base * 0.85,
      lethal
    });
  } else {
    const w = base * (1.2 + rng());
    const d = h * (0.35 + rng() * 0.45);
    const topY = getCeilY(x, z);
    const cy = topY - d * 0.5;
    _spawnPolyRock(x, z, cy, w * 1.1, d, w * 0.85, lethal, 0);
  }
}

/** Floor spike / mound — cone, prism, or crystal shard. */
function _spawnFloorVariety(x, z, lethal) {
  const h = 0.45 + rng() * 2.8;
  const base = 0.06 + rng() * 0.42;
  const roll = rng();
  if (roll < 0.45) {
    _spawnTite(x, z, false, h, base, lethal);
  } else if (roll < 0.72) {
    const geo = new THREE.ConeGeometry(base * 1.15, h, 5 + ((rng() * 4) | 0));
    const m = new THREE.Mesh(geo, lethal ? obstacleCaveMat : caveMat);
    const surfY = getFloorY(x, z) + h * 0.5;
    m.position.set(x, surfY, z);
    scene.add(m);
    obstacleColliders.push({
      type: 'capsule',
      a: new THREE.Vector3(x, surfY - h * 0.5, z),
      b: new THREE.Vector3(x, surfY + h * 0.5, z),
      radius: base * 0.9,
      lethal
    });
  } else {
    const y0 = getFloorY(x, z) + h * 0.35;
    _spawnPolyRock(x, z, y0, base * 1.8, h * 0.65, base * 1.5, lethal, 1 + ((rng() * 2) | 0));
  }
}

// ── DRIP ZONES — fewer, wider “rooms” so formations read as one cave, not scattered kits. ──
// Lethal reds concentrate toward the gallery edge (walls); the middle stays more navigable.
for (let di = 0; di < 7; di++) {
  const zx     = (rng()-0.5) * (CAVE_HALF*2 - 20);
  const zz     = (rng()-0.5) * (CAVE_HALF*2 - 20);
  const spread = 9 + rng() * 14;
  const count  = 6 + Math.floor(rng() * 7);

  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    const rad   = spread * Math.sqrt(rng());  // sqrt = uniform disk distribution
    const x     = Math.max(-CAVE_HALF+2, Math.min(CAVE_HALF-2, zx + Math.cos(angle)*rad));
    const z     = Math.max(-CAVE_HALF+2, Math.min(CAVE_HALF-2, zz + Math.sin(angle)*rad));

    const edge = galleryEdge01(x, z);
    const lethalCeil = rng() < 0.30 + edge * 0.52;
    _spawnCeilingVariety(x, z, lethalCeil);

    if (rng() > 0.42) {
      const x2 = x + (rng() - 0.5) * 0.45;
      const z2 = z + (rng() - 0.5) * 0.45;
      const lethalFloor = rng() < 0.24 + galleryEdge01(x2, z2) * 0.46;
      _spawnFloorVariety(x2, z2, lethalFloor);
    }
  }

  // 1–2 floor-to-ceiling columns per zone (safe pillars — caveMat, lethal false)
  const colCount = 1 + Math.floor(rng() * 2);
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

// ── BREAKDOWN FIELDS — two wide rubble heaps (gallery edges), varied fractured shapes. ──
for (let fi = 0; fi < 2; fi++) {
  const bfx    = (fi === 0 ? -1 : 1) * (CAVE_HALF * 0.22 + rng() * 14);
  const bfz    = (rng() - 0.5) * (CAVE_HALF * 2 - 22);
  const bcount = 8 + Math.floor(rng() * 7);

  for (let i = 0; i < bcount; i++) {
    const angle = rng() * Math.PI * 2;
    const rad   = rng() * (11 + rng() * 8);
    const x     = Math.max(-CAVE_HALF+2, Math.min(CAVE_HALF-2, bfx + Math.cos(angle)*rad));
    const z     = Math.max(-CAVE_HALF+2, Math.min(CAVE_HALF-2, bfz + Math.sin(angle)*rad));
    const s     = 0.45 + rng() * 2.6;
    const edge = galleryEdge01(x, z);
    const shard = s < 0.85 ? 0.82 : s < 1.45 ? 0.52 : 0.22;
    const lethal = rng() < shard * (0.42 + edge * 0.58);
    const yB = getFloorY(x, z) + s * 0.52;
    const vk = (rng() * 5) | 0;
    if (vk === 0) {
      const geo = new THREE.DodecahedronGeometry(s, 0);
      const m  = new THREE.Mesh(geo, lethal ? obstacleCaveMat : caveMat);
      m.position.set(x, yB, z);
      m.rotation.set(rng()*Math.PI, rng()*Math.PI, rng()*Math.PI);
      scene.add(m);
      obstacleColliders.push({ type: 'sphere', center: new THREE.Vector3(x, yB, z), radius: s * 0.85, lethal });
    } else if (vk === 1) {
      const geo = new THREE.IcosahedronGeometry(s, 0);
      const m  = new THREE.Mesh(geo, lethal ? obstacleCaveMat : caveMat);
      m.position.set(x, yB, z);
      m.rotation.set(rng()*Math.PI, rng()*Math.PI, rng()*Math.PI);
      scene.add(m);
      obstacleColliders.push({ type: 'sphere', center: new THREE.Vector3(x, yB, z), radius: s * 0.82, lethal });
    } else if (vk === 2) {
      const t = s * 1.05;
      const geo = new THREE.TetrahedronGeometry(t, 0);
      const m  = new THREE.Mesh(geo, lethal ? obstacleCaveMat : caveMat);
      m.position.set(x, yB, z);
      m.rotation.set(rng()*Math.PI, rng()*Math.PI, rng()*Math.PI);
      scene.add(m);
      obstacleColliders.push({ type: 'sphere', center: new THREE.Vector3(x, yB, z), radius: s * 0.78, lethal });
    } else if (vk === 3) {
      const geo = new THREE.BoxGeometry(s * 1.1, s * 0.75, s * 0.95);
      const m  = new THREE.Mesh(geo, lethal ? obstacleCaveMat : caveMat);
      m.position.set(x, yB, z);
      m.rotation.set(rng()*Math.PI, rng()*Math.PI, rng()*Math.PI);
      scene.add(m);
      obstacleColliders.push({ type: 'sphere', center: new THREE.Vector3(x, yB, z), radius: s * 0.72, lethal });
    } else {
      _spawnPolyRock(x, z, yB, s * 1.05, s * 0.9, s * 0.95, lethal, 2);
    }
  }
}

// ── FLOOR BOULDERS — biased toward the perimeter so the core floor stays readable. ──
for (let i = 0; i < 18; i++) {
  const s = 0.24 + rng() * 1.45;
  let x; let z;
  if (i % 4 !== 0) {
    const ang = rng() * Math.PI * 2;
    const rad = (10 + rng() * 30) * (0.55 + rng() * 0.45);
    x = Math.cos(ang) * rad;
    z = Math.sin(ang) * rad;
  } else {
    x = (rng() - 0.5) * (CAVE_HALF * 2 - 4);
    z = (rng() - 0.5) * (CAVE_HALF * 2 - 4);
  }
  x = Math.max(-CAVE_HALF + 2, Math.min(CAVE_HALF - 2, x));
  z = Math.max(-CAVE_HALF + 2, Math.min(CAVE_HALF - 2, z));
  const lethal = rng() < 0.36 + galleryEdge01(x, z) * 0.44;
  const yB = getFloorY(x, z) + s * 0.55;
  const bRoll = rng();
  if (bRoll < 0.38) {
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), lethal ? obstacleCaveMat : caveMat);
    m.position.set(x, yB, z);
    m.rotation.set(rng()*Math.PI, rng()*Math.PI, rng()*Math.PI);
    scene.add(m);
    obstacleColliders.push({ type: 'sphere', center: new THREE.Vector3(x, yB, z), radius: s * 0.9, lethal });
  } else if (bRoll < 0.62) {
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(s * 0.95, 0), lethal ? obstacleCaveMat : caveMat);
    m.position.set(x, yB, z);
    m.rotation.set(rng()*Math.PI, rng()*Math.PI, rng()*Math.PI);
    scene.add(m);
    obstacleColliders.push({ type: 'sphere', center: new THREE.Vector3(x, yB, z), radius: s * 0.86, lethal });
  } else if (bRoll < 0.82) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.35, s * 0.85, s * 1.1, 6), lethal ? obstacleCaveMat : caveMat);
    m.position.set(x, yB, z);
    m.rotation.set(rng()*Math.PI, rng()*Math.PI, rng()*Math.PI);
    scene.add(m);
    obstacleColliders.push({ type: 'sphere', center: new THREE.Vector3(x, yB, z), radius: s * 0.82, lethal });
  } else {
    _spawnPolyRock(x, z, yB, s * 1.1, s * 0.7, s * 1.05, lethal, 0);
  }
}

// ── LARGE PILLARS — floor-to-ceiling anchors (caveMat, non-lethal); satellites add broken rim detail. ──
for (let i = 0; i < 11; i++) {
  const x = (rng()-0.5) * (CAVE_HALF*2 - 16);
  const z = (rng()-0.5) * (CAVE_HALF*2 - 16);
  if (Math.abs(x) < 10 && Math.abs(z) < 10) { i--; continue; }

  const baseR = 1.05 + rng() * 1.95;
  const topR  = baseR * (0.06 + rng() * 0.28);
  const h     = CAVE_H * (1.45 + rng() * 0.55);
  const floorY = getFloorY(x, z);
  const yC    = floorY + h * 0.5;
  const geo   = new THREE.CylinderGeometry(topR, baseR, h, 10);
  const m     = new THREE.Mesh(geo, caveMat);
  m.position.set(x, yC, z);
  m.rotation.y = rng() * Math.PI;
  scene.add(m);
  obstacleColliders.push({
    type: 'capsule',
    a: new THREE.Vector3(x, floorY, z),
    b: new THREE.Vector3(x, floorY + h, z),
    radius: baseR * 0.88, lethal: false
  });

  const satCount = 2 + Math.floor(rng() * 3);
  for (let k = 0; k < satCount; k++) {
    const ang  = (k / satCount) * Math.PI * 2 + rng() * 0.9;
    const dist = baseR * 1.15 + rng() * 2.8;
    const sx   = x + Math.cos(ang) * dist;
    const sz   = z + Math.sin(ang) * dist;
    const sh   = h * (0.10 + rng() * 0.60);
    const sbr  = baseR * (0.10 + rng() * 0.42);
    const str  = sbr * (0.03 + rng() * 0.22);
    const syC  = getFloorY(sx, sz) + sh * 0.5;
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

for (let i = 0; i < 4; i++) {
  const bias = (rng() - 0.5) * 1.65;
  const cx    = Math.max(-CAVE_HALF + 8, Math.min(CAVE_HALF - 8, (rng() - 0.5) * (CAVE_HALF * 2 - 14) + bias * CAVE_HALF * 0.35));
  const cz    = Math.max(-CAVE_HALF + 8, Math.min(CAVE_HALF - 8, (rng() - 0.5) * (CAVE_HALF * 2 - 14) - bias * CAVE_HALF * 0.35));
  const cw    = 2.4 + rng() * 7.5;
  const ch    = 1.2 + rng() * 5.0;
  const cAng  = rng() * Math.PI;
  const cgeo  = new THREE.PlaneGeometry(cw, ch, Math.max(4, cw*3|0), Math.max(3, ch*3|0));
  // Gentle ripple along the curtain surface
  _displaceZ(cgeo, (u, v) =>
    (_caveNoise2(u*1.3 + cx*0.18 + i*4.1, v*0.85 + cz*0.18) - 0.5) * 0.38
  );
  const cm = new THREE.Mesh(cgeo, curtainMat);
  const ceilY = getCeilY(cx, cz);
  cm.position.set(cx, ceilY - ch * 0.5, cz);
  cm.rotation.y = cAng;
  // scene.add(cm);
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
  // Prefer vertical **middle** of the air column at each (x,z), then try other heights.
  const yFracs = [0.5, 0.44, 0.56, 0.36, 0.64, 0.28, 0.72, 0.2, 0.8, 0.12, 0.88, 0.06, 0.94];
  const rings = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18];
  for (const R of rings) {
    for (let step = 0; step < 28; step++) {
      const a = (step / 28) * Math.PI * 2;
      _spawnTest.set(Math.cos(a) * R, 0, Math.sin(a) * R);
      _spawnTest.x = Math.max(-CAVE_HALF + 3, Math.min(CAVE_HALF - 3, _spawnTest.x));
      _spawnTest.z = Math.max(-CAVE_HALF + 3, Math.min(CAVE_HALF - 3, _spawnTest.z));
      constrainPlayerToWallShell(_spawnTest, SPAWN_CLEAR_R);
      const fY = getFloorY(_spawnTest.x, _spawnTest.z) + SPAWN_CLEAR_R;
      const cY = getCeilY(_spawnTest.x, _spawnTest.z) - SPAWN_CLEAR_R;
      const span = cY - fY;
      if (span < 0.6) continue;
      for (let fi = 0; fi < yFracs.length; fi++) {
        _spawnTest.y = fY + span * yFracs[fi];
        if (!isPointInsideCaveShell(_spawnTest.x, _spawnTest.y, _spawnTest.z, SPAWN_CLEAR_R)) {
          snapPointIntoCaveShell(_spawnTest, SPAWN_CLEAR_R);
        }
        if (spawnFree(_spawnTest, SPAWN_CLEAR_R)) return _spawnTest.clone();
      }
    }
  }
  _spawnTest.set(0, 0, 0);
  snapPointIntoCaveShell(_spawnTest, SPAWN_CLEAR_R);
  const f0 = getFloorY(0, 0) + SPAWN_CLEAR_R;
  const c0 = getCeilY(0, 0) - SPAWN_CLEAR_R;
  _spawnTest.y = (f0 + c0) * 0.5;
  clampPointToFloorCeiling(_spawnTest, SPAWN_CLEAR_R);
  if (spawnFree(_spawnTest, SPAWN_CLEAR_R)) return _spawnTest.clone();
  return new THREE.Vector3(0, (f0 + c0) * 0.5, 0);
}

player.position.copy(findSafeSpawn());

// Cave shell + all grid props — sonar bolts
const sonarRayTargets = [];
scene.traverse((o) => {
  if (!o.isMesh) return;
  if (o.material === caveMat || o.material === obstacleCaveMat || o.material === curtainMat) sonarRayTargets.push(o);
});

// ═══════════════════════════════════════════════════════════════════════
//  EXIT HOLE  — gold tunnel hidden in dark; random floor or wall placement
// ═══════════════════════════════════════════════════════════════════════
{
  // Pick placement: floor | ceiling | 4 walls — each ~16.7%
  const exitRoll = rng();
  if (exitRoll < 0.167) {
    // ── Floor hole ──────────────────────────────────────────────────────
    exitKind = 'floor';
    exitIsFloor = true;
    const angle = rng() * Math.PI * 2;
    const dist  = 22 + rng() * 24;
    const ex    = Math.cos(angle) * dist;
    const ez    = Math.sin(angle) * dist;
    const ey    = getFloorY(ex, ez);
    exitAnchor.set(ex, ey, ez);
    exitNormal.set(0, -1, 0);   // tunnel goes downward
    exitCenter.set(ex, ey, ez);
  } else if (exitRoll < 0.334) {
    // ── Ceiling hole ─────────────────────────────────────────────────────
    exitKind = 'ceiling';
    exitIsFloor = false;
    const angle = rng() * Math.PI * 2;
    const dist  = 22 + rng() * 24;
    const ex    = Math.cos(angle) * dist;
    const ez    = Math.sin(angle) * dist;
    const ey    = getCeilY(ex, ez);
    exitAnchor.set(ex, ey, ez);
    exitNormal.set(0, 1, 0);    // tunnel goes upward
    exitCenter.set(ex, ey, ez);
  } else {
    // ── Wall hole ────────────────────────────────────────────────────────
    exitKind = 'wall';
    exitIsFloor = false;
    const wallIdx = Math.min(3, Math.floor((exitRoll - 0.334) / 0.1665));  // 0-3
    const wallDist = CAVE_HALF - 3;
    const caveMidY = CAVE_H * 0.5;
    const wallY    = caveMidY * 0.4 + rng() * caveMidY * 0.5;
    const along    = (rng() - 0.5) * (CAVE_HALF * 1.2);
    let wx = 0, wz = 0;
    if      (wallIdx === 0) { wz = -wallDist; wx = along; exitNormal.set(0, 0,  1); }  // north wall
    else if (wallIdx === 1) { wz =  wallDist; wx = along; exitNormal.set(0, 0, -1); }  // south wall
    else if (wallIdx === 2) { wx = -wallDist; wz = along; exitNormal.set( 1, 0, 0); }  // west wall
    else                    { wx =  wallDist; wz = along; exitNormal.set(-1, 0, 0); }  // east wall
    exitAnchor.set(wx, wallY, wz);
    exitCenter.set(wx + exitNormal.x * 0.5, wallY, wz + exitNormal.z * 0.5);
  }

  // Quaternion that rotates geometry's +Z normal → exitNormal
  // (all flat geometry below is built in the XY plane, normal = +Z)
  const faceQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1), exitNormal
  );

  // ── Build an irregular (organic) hole shape in the XY plane ──────────
  // Each sample angle gets a noisy radius so the boundary looks like a
  // natural crack in the rock rather than a perfect circle.
  const N = 48;
  const holeSeed = rng() * 100;
  const noisyR = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const noise =  0.22 * Math.sin(a * 2.1 + holeSeed)
                 + 0.15 * Math.sin(a * 3.7 + holeSeed * 1.6)
                 + 0.09 * Math.sin(a * 5.9 + holeSeed * 2.3)
                 + (rng() - 0.5) * 0.14;
    noisyR.push(EXIT_RADIUS + noise);
  }

  // ── Hole interior + tunnel void — BasicMaterial only (no pulse uniforms) + fog off so it never tints blue
  const holeVoidMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.DoubleSide,
    depthWrite: true,
    depthTest: true,
    fog: false
  });
  // Black hole disc: same plane & orientation as gold rim, slightly toward cave shell, radius inside inner gold edge
  const holeInnerScale = 0.856; // just inside rim inner (~0.86×R) so gold ring is never covered
  const fillPositions = [];
  const fillIndices   = [];
  fillPositions.push(0, 0, 0);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const rr = noisyR[i] * holeInnerScale;
    fillPositions.push(Math.cos(a) * rr, Math.sin(a) * rr, 0);
  }
  for (let i = 0; i < N; i++) {
    fillIndices.push(0, i + 1, (i + 1) % N + 1);
  }
  const fillGeo = new THREE.BufferGeometry();
  fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(fillPositions, 3));
  fillGeo.setIndex(fillIndices);

  const rimIntoRoom = exitKind === 'wall' ? 4.6 : -2.35;
  // Same plane as rim: move a few cm toward anchor along exit line (behind gold); rim’s polygonOffset keeps gold on top
  const holePlaneAlong = rimIntoRoom > 0 ? rimIntoRoom - 0.038 : rimIntoRoom + 0.038;
  const fillMesh = new THREE.Mesh(fillGeo, holeVoidMat);
  fillMesh.quaternion.copy(faceQuat);
  fillMesh.position.copy(exitAnchor).addScaledVector(exitNormal, holePlaneAlong);
  fillMesh.renderOrder = 6;
  scene.add(fillMesh);

  // ── Gold outline strip — thin annulus with same irregular boundary ────
  // Inner edge = 88% of noisyR, outer edge = noisyR + small extra jagged bump
  const rimPositions = [];
  const rimIndices   = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r     = noisyR[i];
    const inner = r * 0.86;
    const outer = r + 0.26 + (rng() - 0.5) * 0.12;
    rimPositions.push(Math.cos(a) * inner, Math.sin(a) * inner, 0);  // even = inner
    rimPositions.push(Math.cos(a) * outer, Math.sin(a) * outer, 0);  // odd  = outer
  }
  for (let i = 0; i < N; i++) {
    const a  = i * 2;
    const b  = ((i + 1) % N) * 2;
    rimIndices.push(a, b,     a + 1);
    rimIndices.push(b, b + 1, a + 1);
  }
  const rimGeo = new THREE.BufferGeometry();
  rimGeo.setAttribute('position', new THREE.Float32BufferAttribute(rimPositions, 3));
  rimGeo.setIndex(rimIndices);
  const rimMesh = new THREE.Mesh(rimGeo, exitRingMat);
  rimMesh.quaternion.copy(faceQuat);
  rimMesh.position.copy(exitAnchor).addScaledVector(exitNormal, rimIntoRoom);
  rimMesh.renderOrder = 10;
  scene.add(rimMesh);
  sonarRayTargets.push(rimMesh);
  sonarRayTargets.push(fillMesh);
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
//  SONAR BOLT + REVERB (crosshair aim → impact drives pulse origin)
// ═══════════════════════════════════════════════════════════════════════
const PULSE_SPEED    = 13;    // world units / second
const PULSE_MAXR     = 120;   // keep data alive until everything has faded
const SONAR_COOLDOWN = 5.5;   // seconds between shots
let   sonarCooldown  = 0;     // counts down to 0

const PROJ_SPEED     = 62;
const PROJ_MAX_DIST  = 200;

const raycaster = new THREE.Raycaster();
raycaster.near = 0.02;
raycaster.far  = 320;

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

const flashEl      = document.getElementById('flash');
const sonarBarWrap = document.getElementById('sonar-bar-wrap');
const sonarBarFill = document.getElementById('sonar-bar-fill');

function updateSonarBar() {
  if (sonarCooldown <= 0) {
    sonarBarFill.style.transform = 'scaleX(1)';
    if (!sonarBarFill.classList.contains('ready')) {
      sonarBarFill.className = 'ready';
    }
  } else {
    const progress = 1 - sonarCooldown / SONAR_COOLDOWN;
    sonarBarFill.className = 'charging';
    sonarBarFill.style.transform = 'scaleX(' + progress.toFixed(3) + ')';
  }
}

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
  if (sonarCooldown > 0) return;
  sonarCooldown = SONAR_COOLDOWN;

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
let playerWon  = false;

document.addEventListener('keydown', e => { keys[e.code] = true;  });
document.addEventListener('keyup',   e => { keys[e.code] = false; });

/** True while the controls / sonar tutorial is on screen before the fade-out (don’t start HUD yet). */
function isTutorialIntroShowing() {
  const tut = document.getElementById('tutorial');
  if (!tut) return false;
  return tut.classList.contains('visible') && !tut.classList.contains('fade-out');
}

function _startGame() {
  if (gameStarted || playerDead) return;
  gameStarted = true;
  document.getElementById('overlay').style.display        = 'none';
  document.getElementById('gameover').style.display       = 'none';
  document.getElementById('ui').style.display             = '';
  document.getElementById('crosshair').style.display      = '';
  sonarBarWrap.style.display                               = '';
}

document.addEventListener('click', () => {
  if (playerDead) return;
  if (isTutorialIntroShowing()) return;
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
  if (isTutorialIntroShowing()) return;
  if (pointerLocked && !playerDead) _startGame();
});

function _doRestart() {
  resetRun();
  document.getElementById('gameover').style.display       = 'none';
  document.getElementById('winscreen').style.display      = 'none';
  document.getElementById('crosshair').style.display      = '';
  sonarBarWrap.style.display                               = '';
  gameStarted = true;
  const req = document.body.requestPointerLock();
  if (req && typeof req.catch === 'function') req.catch(() => {});
}

document.getElementById('restart-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!playerDead) return;
  _doRestart();
});

document.getElementById('play-again-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!playerWon) return;
  _doRestart();
});

function goToHomeScreen() {
  clearSonarFX();
  try { document.exitPointerLock(); } catch (_) {}
  pointerLocked = false;
  playerWon  = false;
  playerDead = false;
  gameStarted = false;
  resetRun();
  document.getElementById('winscreen').style.display       = 'none';
  document.getElementById('gameover').style.display        = 'none';
  document.getElementById('ui').style.display              = 'none';
  document.getElementById('crosshair').style.display       = 'none';
  sonarBarWrap.style.display                                = 'none';
  const tut = document.getElementById('tutorial');
  tut.classList.remove('visible', 'fade-out');
  tut.style.display = 'flex';
  document.getElementById('overlay').style.display          = 'flex';
}

document.getElementById('win-exit-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  goToHomeScreen();
});

document.addEventListener('mousedown', e => {
  if (playerDead || playerWon || !gameStarted || e.button !== 0) return;
  fireSonarBolt();
});

document.addEventListener('mousemove', e => {
  if (!gameStarted) return;
  yaw   -= e.movementX * 0.0022;
  pitch -= e.movementY * 0.0022;
  pitch  = Math.max(-Math.PI*0.18, Math.min(Math.PI*0.42, pitch));
});

// ═══════════════════════════════════════════════════════════════════════
//  MOVEMENT
// ═══════════════════════════════════════════════════════════════════════
const clock = new THREE.Clock();
let flapPhase = 0;

const _camEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _camForward = new THREE.Vector3();
const _camLook = new THREE.Vector3();
const _camDelta = new THREE.Vector3();
const CAM_DIST = 6.2;
const CAM_HEIGHT = 1.35;
const CAM_LOOK_AHEAD = 1.35;
/** Keep lens inside rock shell so you never see cave surfaces from the outside (avoids reversed / missing shading). */
const CAM_SHELL_MARGIN = 0.48;

const _sepObs = new THREE.Vector3();

function triggerGameOver(deathCause) {
  if (playerDead || playerWon) return;
  playerDead = true;
  clearSonarFX();
  try { document.exitPointerLock(); } catch (_) {}
  pointerLocked = false;
  const reasonEl = document.getElementById('gameover-reason');
  if (reasonEl) {
    reasonEl.textContent =
      deathCause === 'hawk'
        ? 'A hawk caught you in the dark.'
        : 'You struck a lethal obstacle.';
  }
  document.getElementById('gameover').style.display       = 'flex';
  document.getElementById('ui').style.display             = 'none';
  document.getElementById('crosshair').style.display      = 'none';
  sonarBarWrap.style.display                               = 'none';
}

function triggerWin() {
  if (playerWon || playerDead) return;
  playerWon = true;
  clearSonarFX();
  try { document.exitPointerLock(); } catch (_) {}
  pointerLocked = false;
  document.getElementById('winscreen').style.display      = 'flex';
  document.getElementById('ui').style.display             = 'none';
  document.getElementById('crosshair').style.display      = 'none';
  sonarBarWrap.style.display                               = 'none';
}

function resetRun() {
  clearSonarFX();
  playerDead = false;
  playerWon  = false;
  player.position.copy(findSafeSpawn());
  player.rotation.set(0, 0, 0);
  yaw = 0;
  pitch = 0;
  flapPhase = 0;
  sonarCooldown = 0;
  Object.keys(keys).forEach((k) => { keys[k] = false; });
  resetHawks();
}

function resolveObstacleCollisions() {
  const p = player.position;
  const pr = PLAYER_COLLIDE_R;

  for (let i = 0; i < obstacleColliders.length; i++) {
    const c = obstacleColliders[i];
    if (!c.lethal) continue;
    const depth = playerObstacleOverlapDepth(p, c, pr);
    if (depth > LETHAL_OVERLAP_EPS) {
      triggerGameOver('obstacle');
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
  _camDelta.copy(_camForward).multiplyScalar(-CAM_DIST);
  _camDelta.y += CAM_HEIGHT;

  let t = 1.0;
  for (let iter = 0; iter < 26; iter++) {
    camera.position.copy(player.position).addScaledVector(_camDelta, t);
    snapPointIntoCaveShell(camera.position, CAM_SHELL_MARGIN);
    if (isPointInsideCaveShell(camera.position.x, camera.position.y, camera.position.z, CAM_SHELL_MARGIN)) {
      break;
    }
    t *= 0.88;
    if (t < 0.06) {
      camera.position.copy(player.position);
      camera.position.y += CAM_HEIGHT * 0.55;
      snapPointIntoCaveShell(camera.position, CAM_SHELL_MARGIN);
      break;
    }
  }
  for (let k = 0; k < 5; k++) {
    if (isPointInsideCaveShell(camera.position.x, camera.position.y, camera.position.z, CAM_SHELL_MARGIN)) break;
    camera.position.lerp(player.position, 0.45);
    snapPointIntoCaveShell(camera.position, CAM_SHELL_MARGIN);
  }

  _camLook.copy(player.position).addScaledVector(_camForward, CAM_LOOK_AHEAD);
  _camLook.y += 0.42;
  camera.up.set(0, 1, 0);
  camera.lookAt(_camLook);
}

function updatePlayer(dt) {
  if (playerDead || playerWon) return;

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

  for (let pass = 0; pass < 8; pass++) {
    constrainPlayerToWallShell(player.position, PLAYER_COLLIDE_R);
    clampPointToFloorCeiling(player.position, PLAYER_COLLIDE_R);
  }

  resolveObstacleCollisions();

  for (let pass = 0; pass < 4; pass++) {
    constrainPlayerToWallShell(player.position, PLAYER_COLLIDE_R);
    clampPointToFloorCeiling(player.position, PLAYER_COLLIDE_R);
  }

  // Exit hole win — after constraints so position matches collision; body centre vs rim plane
  getPlayerBodyCenterWorld(_exitWinPos);
  if (playerInExitWinVolume(_exitWinPos.x, _exitWinPos.y, _exitWinPos.z)) {
    triggerWin();
    return;
  }

  player.rotation.order = 'YXZ';
  player.rotation.y = yaw;
  player.rotation.x = pitch * 0.22;
}

// ═══════════════════════════════════════════════════════════════════════
//  HAWK SONAR MATERIAL
//  Same blue sonar grid as the cave, but with skinning so it deforms with
//  the eagle skeleton.  Hawks are invisible until a pulse sweeps over them.
// ═══════════════════════════════════════════════════════════════════════
const hawkVertShader = /* glsl */`
  #include <common>
  #include <skinning_pars_vertex>

  varying vec3 vWorldPos;

  void main() {
    vec3 transformed = vec3(position);
    #include <skinbase_vertex>
    #include <skinning_vertex>

    vec4 wp    = modelMatrix * vec4(transformed, 1.0);
    vWorldPos  = wp.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  }
`;

const hawkMat = new THREE.ShaderMaterial({
  vertexShader:   hawkVertShader,
  fragmentShader: fragShaderObstacle, // red grid + pulse — matches lethal obstacles
  uniforms: {
    uPulses: { value: uPulseVec4 },  // shared with cave — same pulse data
    uCamPos: { value: camera.position }
  },
  skinning: true,
  side: THREE.DoubleSide,
});

// ═══════════════════════════════════════════════════════════════════════
//  HAWKS — 3D eagle GLTF (one full loader.parse per bird: skinned clones often render blank in r128)
// ═══════════════════════════════════════════════════════════════════════
const HAWK_HIT_R        = 0.55;   // hawk body sphere
const HAWK_PLAYER_HIT_R = 0.40;   // player body sphere
const HAWK_WANDER_SPEED    = 3.5;
const HAWK_ATTACK_SPEED    = 9.0;
const HAWK_ATTACK_DURATION = 3.5;  // max chase time (close-range hit)
const HAWK_DETECT_RANGE    = 32;   // units from pulse origin — beyond this, no alert
const HAWK_PROXIMITY_R     = 7;   // units — hawk always attacks if closer than this
const _hawks = [];

const _wpTemp = new THREE.Vector3();
function _pickWanderPoint(out) {
  for (let attempt = 0; attempt < 20; attempt++) {
    out.set(
      (Math.random() - 0.5) * 76,
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 76
    );
    snapPointIntoCaveShell(out, 1.5);
    clampPointToFloorCeiling(out, 1.5);
    return;
  }
}
const _hawkSpawnPositions = (function buildHawkSpawnPositions() {
  const out = [];
  const minFromPlayer = 17;
  const minFromEach = 13;
  for (let attempt = 0; attempt < 140 && out.length < 2; attempt++) {
    const hx = (rng() - 0.5) * (CAVE_HALF * 2 - 22);
    const hz = (rng() - 0.5) * (CAVE_HALF * 2 - 22);
    const hy = getFloorY(hx, hz) + 4 + rng() * 4.5;
    const v = new THREE.Vector3(hx, hy, hz);
    snapPointIntoCaveShell(v, 0.35);
    clampPointToFloorCeiling(v, 0.35);
    if (v.distanceTo(player.position) < minFromPlayer) continue;
    let ok = true;
    for (let j = 0; j < out.length; j++) {
      if (out[j].distanceTo(v) < minFromEach) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(v.clone());
  }
  const _push = new THREE.Vector3();
  while (out.length < 2) {
    const k = out.length;
    _push.set(Math.cos(k * 2.1) * 24, 4, Math.sin(k * 2.1) * 24).add(player.position);
    snapPointIntoCaveShell(_push, 0.35);
    clampPointToFloorCeiling(_push, 0.35);
    out.push(_push.clone());
  }
  return out;
})();

function spawnHawkFromFreshGltf(gltf, initPos) {
  const root = new THREE.Group();
  root.position.copy(initPos);
  root.frustumCulled = false;
  const hawkMount = new THREE.Group();
  root.add(hawkMount);
  const eagle = gltf.scene;
  configureEagleGltf(eagle);
  hawkMount.add(eagle);
  scene.add(root);
  eagle.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) {
      o.updateMatrixWorld(true);
    }
  });
  root.updateMatrixWorld(true);

  let mixer = null;
  if (gltf.animations && gltf.animations.length) {
    mixer = new THREE.AnimationMixer(eagle);
    mixer.clipAction(gltf.animations[0]).play();
  }

  const h = {
    root,
    hawkMount,
    eagle,
    mixer,
    initPos: initPos.clone(),
    state: 'WANDER',
    attackTimer: 0,
    wanderTarget: new THREE.Vector3(),
    heading: new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize(),
    currentSpeed: HAWK_WANDER_SPEED,
  };
  _pickWanderPoint(h.wanderTarget);
  _hawks.push(h);
}

_hawkSpawnPositions.forEach((initPos) => {
  new THREE.GLTFLoader().load(
    'eagle.gltf',
    (gltf) => {
      spawnHawkFromFreshGltf(gltf, initPos);
    },
    undefined,
    (err) => console.error('eagle.gltf load error:', err)
  );
});

const _hawkDir      = new THREE.Vector3();
const _hawkBodyPos  = new THREE.Vector3();
const _playerBodyCenter = new THREE.Vector3();
const _batHitBox = new THREE.Box3();

/** World-space center of the bat mesh (fair hit target vs player group origin). */
function getPlayerBodyCenterWorld(out) {
  batMount.updateMatrixWorld(true);
  if (batMount.children.length > 0) {
    _batHitBox.setFromObject(batMount);
    _batHitBox.getCenter(out);
  } else {
    player.localToWorld(out.set(0, 0.35, 0));
  }
}

/**
 * World-space body centre of the hawk.
 * We use the skeleton ROOT BONE (bone[0]) which is the hip/torso anchor —
 * always at the physical centre of the bird regardless of wing pose.
 * Averaging all bones fails because wing/feather bones outnumber body bones
 * and drag the average far out into the wingtips.
 */
function getHawkBodyCenterWorld(h, out) {
  if (h.eagle) {
    let found = false;
    h.eagle.traverse((o) => {
      if (found || !o.isSkinnedMesh || !o.skeleton) return;
      const rootBone = o.skeleton.bones[0];
      if (rootBone) { rootBone.getWorldPosition(out); found = true; }
    });
    if (found) return;
  }
  out.copy(h.root.position);
}

const HAWK_ROT_SMOOTH = 7.0;
const HAWK_BANK_SCALE = 0.28;

function updateHawks(dt) {
  getPlayerBodyCenterWorld(_playerBodyCenter);

  for (const h of _hawks) {
    // ── Illumination check: pulse ring reaches hawk AND within signal range ──
    // attackTimer counts DOWN to 0 → return to wander
    for (const p of activePulses) {
      getHawkBodyCenterWorld(h, _hawkBodyPos);
      const distToOrigin = _hawkBodyPos.distanceTo(p.origin);
      if (distToOrigin > HAWK_DETECT_RANGE) continue;   // signal too weak at this distance
      if (distToOrigin > p.radius)          continue;   // ring hasn't reached hawk yet
      // Strength: 1.0 right at the source, approaching 0 at HAWK_DETECT_RANGE
      const strength  = 1 - distToOrigin / HAWK_DETECT_RANGE;
      const chaseDur  = HAWK_ATTACK_DURATION * strength;
      h.state = 'ATTACK';
      // Only extend the timer — never shorten an ongoing chase with a weaker ping
      if (chaseDur > h.attackTimer) h.attackTimer = chaseDur;
      break;
    }

    // ── Proximity trigger: hawk notices the player when close enough ──
    if (h.state === 'WANDER') {
      getHawkBodyCenterWorld(h, _hawkBodyPos);
      const proximityDist = _hawkBodyPos.distanceTo(_playerBodyCenter);
      if (proximityDist < HAWK_PROXIMITY_R) {
        h.state = 'ATTACK';
        // Scale duration by how close — right on top = full duration
        const strength = 1 - proximityDist / HAWK_PROXIMITY_R;
        const chaseDur = HAWK_ATTACK_DURATION * (0.5 + 0.5 * strength); // min 50% duration
        if (chaseDur > h.attackTimer) h.attackTimer = chaseDur;
      }
    }

    const TURN_RATE  = 2.2;   // heading lerp speed (higher = snappier turn)
    const SPEED_RATE = 2.5;   // speed lerp rate (units/s²)

    // ── Resolve state, pick desired heading & target speed ───────────
    let desiredSpeed = HAWK_WANDER_SPEED;
    let targetTimeScale = 1.0;

    if (h.state === 'ATTACK') {
      h.attackTimer -= dt;
      if (h.attackTimer <= 0) {
        h.state = 'WANDER';
        h.attackTimer = 0;
        _pickWanderPoint(h.wanderTarget);
      } else {
        desiredSpeed    = HAWK_ATTACK_SPEED;
        targetTimeScale = 2.2;
      }
    }

    // Compute raw desired direction toward current target.
    // In ATTACK mode: chase _playerBodyCenter but correct for the hawk's own
    // body-to-root offset so the hawk body (not its root) intercepts the player.
    if (h.state === 'ATTACK') {
      // Aim so hawk's BODY CENTER reaches player's body center, not root-to-root.
      // direction = playerBodyCenter - hawkBodyCenter
      getHawkBodyCenterWorld(h, _hawkBodyPos);
      _hawkDir.subVectors(_playerBodyCenter, _hawkBodyPos);
    } else {
      _hawkDir.subVectors(h.wanderTarget, h.root.position);
    }
    const distToTarget = _hawkDir.length();

    if (h.state === 'WANDER' && distToTarget < 2.0) {
      _pickWanderPoint(h.wanderTarget);
    }

    // ── Lerp heading toward desired direction ─────────────────────────
    if (distToTarget > 0.1) {
      _hawkDir.normalize();
      h.heading.lerp(_hawkDir, Math.min(1, TURN_RATE * dt));
      if (h.heading.lengthSq() > 0.0001) h.heading.normalize();
    }

    // ── Lerp speed toward target ──────────────────────────────────────
    h.currentSpeed += (desiredSpeed - h.currentSpeed) * Math.min(1, SPEED_RATE * dt);

    // ── Move along smoothed heading at smoothed speed ─────────────────
    h.root.position.addScaledVector(h.heading, h.currentSpeed * dt);

    // ── Lerp wing animation speed ─────────────────────────────────────
    if (h.mixer) {
      h.mixer.timeScale += (targetTimeScale - h.mixer.timeScale) * Math.min(1, SPEED_RATE * dt);
    }

    // ── Yaw: face smoothed heading direction ──────────────────────────
    const moveX = h.heading.x;
    const moveZ = h.heading.z;
    if (moveX !== 0 || moveZ !== 0) {
      const targetY = Math.atan2(-moveZ, moveX);
      let diff = targetY - h.root.rotation.y;
      while (diff >  Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      h.root.rotation.y += diff * Math.min(1, HAWK_ROT_SMOOTH * dt);
      h.root.rotation.z  = -diff * HAWK_BANK_SCALE;
    }

    // ── Pitch: tilt with vertical component of heading ────────────────
    const horizLen  = Math.sqrt(moveX * moveX + moveZ * moveZ);
    const targetPitch = Math.atan2(h.heading.y, Math.max(horizLen, 0.01));
    const pitchDiff = targetPitch - h.hawkMount.rotation.z;
    h.hawkMount.rotation.z += pitchDiff * Math.min(1, HAWK_ROT_SMOOTH * dt);

    // ── Lethal contact (mesh centers — not root pivots, so yaw/bank don’t skew the hit) ──
    getHawkBodyCenterWorld(h, _hawkBodyPos);
    if (
      _hawkBodyPos.distanceTo(_playerBodyCenter) <
      HAWK_HIT_R + HAWK_PLAYER_HIT_R
    ) {
      triggerGameOver('hawk');
      return;
    }
  }
}

function resetHawks() {
  for (const h of _hawks) {
    h.root.position.copy(h.initPos);
    h.root.rotation.set(0, 0, 0);
    h.hawkMount.rotation.z = 0;
    h.state        = 'WANDER';
    h.attackTimer  = 0;
    h.currentSpeed = HAWK_WANDER_SPEED;
    h.heading.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
    _pickWanderPoint(h.wanderTarget);
    if (h.mixer) h.mixer.timeScale = 1.0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  ANIMATE LOOP
// ═══════════════════════════════════════════════════════════════════════
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  // Skinning must be current before AABB hit tests on bat / eagles
  if (batMixer) batMixer.update(dt);
  for (const h of _hawks) {
    if (h.mixer) h.mixer.update(dt);
  }

  if (gameStarted && !playerDead && !playerWon) updatePlayer(dt);
  if (gameStarted && !playerDead && !playerWon) updateHawks(dt);
  updateThirdPersonCamera();

  // Sonar cooldown
  if (sonarCooldown > 0) sonarCooldown -= dt;
  if (!playerDead && !playerWon) updateSonarBar();

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

  if (gameStarted) renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

animate();