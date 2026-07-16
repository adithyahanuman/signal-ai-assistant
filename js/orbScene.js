// orbScene.js — SIGNAL neural orb scene (vanilla JS)
// Light-blue wireframe orb: outer shell, panels, secondary shell, inner core,
// orbiting debris, dust particles, floating code text, scan rings, bloom + chromatic aberration.

import * as THREE from "three";
import { OrbitControls }   from "three/addons/controls/OrbitControls.js";
import { EffectComposer }  from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass }      from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass }      from "three/addons/postprocessing/ShaderPass.js";

const HOME_POSITION = new THREE.Vector3(0, 0.5, 5.5);
const MIN_DISTANCE  = 0.6;
const MAX_DISTANCE  = 40;

/**
 * Creates the SIGNAL orb scene inside `container`.
 * @param {HTMLElement} container
 * @param {{ interactive?: boolean }} options
 *   interactive=true  → OrbitControls enabled (drag/scroll + hand-gesture API)
 *   interactive=false → auto-rotating ambient mode (landing / login)
 */
export function createOrbScene(container, { interactive = true } = {}) {
  const width  = container.clientWidth  || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;

  // ——— SCENE ———
  const scene    = new THREE.Scene();
  const camera   = new THREE.PerspectiveCamera(55, width / height, 0.1, 500);
  camera.position.copy(HOME_POSITION);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping         = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.42;
  container.appendChild(renderer.domElement);

  // ——— POST-PROCESSING ———
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.65, 0.28, 0.38);
  composer.addPass(bloom);

  const chromaticShader = {
    uniforms: {
      tDiffuse:   { value: null },
      uTime:      { value: 0 },
      uIntensity: { value: 0.003 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform float uIntensity;
      varying vec2 vUv;
      void main() {
        vec2 dir    = vUv - vec2(0.5);
        float d     = length(dir);
        float offset = uIntensity * d;
        float flicker = 1.0 + 0.02 * sin(uTime * 30.0) * sin(uTime * 7.3);
        vec4 cr = texture2D(tDiffuse, vUv + dir * offset);
        vec4 cg = texture2D(tDiffuse, vUv);
        vec4 cb = texture2D(tDiffuse, vUv - dir * offset * 0.5);
        gl_FragColor = vec4(cr.r * 0.55, cg.g * 1.05, cb.b * 1.3, 1.0) * flicker;
        gl_FragColor.rgb = mix(gl_FragColor.rgb,
          gl_FragColor.rgb * vec3(0.5, 0.85, 1.35), 0.25);
      }
    `,
  };
  const chromaticPass = new ShaderPass(chromaticShader);
  composer.addPass(chromaticPass);

  // ——— ORBIT CONTROLS ———
  let controls = null;
  if (interactive) {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping  = true;
    controls.dampingFactor  = 0.04;
    controls.minDistance    = MIN_DISTANCE;
    controls.maxDistance    = MAX_DISTANCE;
    controls.zoomSpeed      = 1.4;
    controls.enablePan      = false;
  }

  // ——— COLORS (light blue palette) ———
  const C_BRIGHT = 0x7fe8ff;
  const C_MID    = 0x4db8ff;
  const C_DIM    = 0x2a6090;
  const C_FAINT  = 0x142840;
  const C_HOT    = 0xb8f0ff;

  // ——— ORB ROOT ———
  const orbGroup = new THREE.Group();
  scene.add(orbGroup);

  // ——— HELPERS ———
  function lineMat(color, opacity = 1) {
    return new THREE.LineBasicMaterial({
      color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
  }

  function latRing(radius, lat, segs = 120) {
    const r = radius * Math.cos(lat);
    const y = radius * Math.sin(lat);
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a)));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  function meridian(radius, lon, segs = 120) {
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const lat = (i / segs) * Math.PI - Math.PI / 2;
      pts.push(new THREE.Vector3(
        radius * Math.cos(lat) * Math.cos(lon),
        radius * Math.sin(lat),
        radius * Math.cos(lat) * Math.sin(lon),
      ));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  // ══════════════════════════════════════════════
  // LAYER 1 — OUTER SHELL: dense wireframe grid
  // ══════════════════════════════════════════════
  const outerShell = new THREE.Group();
  const R1 = 2.0;

  for (let i = -15; i <= 15; i++) {
    const lat     = (i / 15) * (Math.PI / 2) * 0.95;
    const opacity = i % 3 === 0 ? 0.28 : 0.07;
    const color   = i % 3 === 0 ? C_MID : C_FAINT;
    outerShell.add(new THREE.Line(latRing(R1, lat), lineMat(color, opacity)));
  }

  for (let i = 0; i < 24; i++) {
    const lon     = (i / 24) * Math.PI * 2;
    const isMajor = i % 6 === 0;
    outerShell.add(new THREE.Line(
      meridian(R1, lon),
      lineMat(isMajor ? C_MID : C_FAINT, isMajor ? 0.32 : 0.05),
    ));
  }

  // 4 bright cross meridians — slimmed
  const CROSS_LINES  = 5;
  const CROSS_SPREAD = 0.06;
  for (let i = 0; i < 4; i++) {
    const lon = (i / 4) * Math.PI * 2;
    for (let j = 0; j < CROSS_LINES; j++) {
      const tt      = (j / (CROSS_LINES - 1)) * 2 - 1;
      const offset  = (tt * CROSS_SPREAD) / 2;
      const falloff = 1 - Math.abs(tt) * 0.7;
      const opacity = 0.5 * falloff;
      const color   = Math.abs(tt) < 0.3 ? C_BRIGHT : C_MID;
      outerShell.add(new THREE.Line(meridian(R1, lon + offset, 200), lineMat(color, opacity)));
    }
  }

  // Bright equator band — slimmed
  const EQ_LINES  = 5;
  const EQ_SPREAD = 0.08;
  for (let j = 0; j < EQ_LINES; j++) {
    const tt      = (j / (EQ_LINES - 1)) * 2 - 1;
    const offset  = (tt * EQ_SPREAD) / 2;
    const falloff = 1 - Math.abs(tt) * 0.65;
    const opacity = 0.45 * falloff;
    const color   = Math.abs(tt) < 0.3 ? C_BRIGHT : C_MID;
    outerShell.add(new THREE.Line(latRing(R1, offset, 200), lineMat(color, opacity)));
  }

  orbGroup.add(outerShell);

  // ══════════════════════════════════════════════
  // LAYER 2 — GRID PANELS on sphere surface
  // ══════════════════════════════════════════════
  const panelGroup = new THREE.Group();

  function createSpherePanel(latCenter, lonCenter, latSpan, lonSpan, radius, divisions = 4) {
    const group = new THREE.Group();
    const mat   = lineMat(C_DIM, 0.25);
    // horizontal lines
    for (let i = 0; i <= divisions; i++) {
      const lat = latCenter - latSpan / 2 + (i / divisions) * latSpan;
      const pts = [];
      for (let j = 0; j <= divisions * 4; j++) {
        const lon = lonCenter - lonSpan / 2 + (j / (divisions * 4)) * lonSpan;
        pts.push(new THREE.Vector3(
          radius * Math.cos(lat) * Math.cos(lon),
          radius * Math.sin(lat),
          radius * Math.cos(lat) * Math.sin(lon),
        ));
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    // vertical lines
    for (let j = 0; j <= divisions; j++) {
      const lon = lonCenter - lonSpan / 2 + (j / divisions) * lonSpan;
      const pts = [];
      for (let i = 0; i <= divisions * 4; i++) {
        const lat = latCenter - latSpan / 2 + (i / (divisions * 4)) * latSpan;
        pts.push(new THREE.Vector3(
          radius * Math.cos(lat) * Math.cos(lon),
          radius * Math.sin(lat),
          radius * Math.cos(lat) * Math.sin(lon),
        ));
      }
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    return group;
  }

  for (let i = 0; i < 30; i++) {
    const lat  = (Math.random() - 0.5) * Math.PI * 0.8;
    const lon  = Math.random() * Math.PI * 2;
    const size = 0.15 + Math.random() * 0.25;
    panelGroup.add(createSpherePanel(lat, lon, size, size, R1 + 0.01, 3 + Math.floor(Math.random() * 3)));
  }
  orbGroup.add(panelGroup);

  // ══════════════════════════════════════════════
  // LAYER 3 — SECONDARY SHELL: partial arcs
  // ══════════════════════════════════════════════
  const shell2 = new THREE.Group();
  const R2 = 2.12;

  for (let i = 0; i < 16; i++) {
    const lat      = (Math.random() - 0.5) * Math.PI * 0.85;
    const startLon = Math.random() * Math.PI * 2;
    const arcLen   = 0.3 + Math.random() * 1.2;
    const pts      = [];
    const segs     = 60;
    const r        = R2 * Math.cos(lat);
    const y        = R2 * Math.sin(lat);
    for (let j = 0; j <= segs; j++) {
      const a = startLon + (j / segs) * arcLen;
      pts.push(new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a)));
    }
    shell2.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      lineMat(C_MID, 0.2 + Math.random() * 0.3),
    ));
  }
  for (let i = 0; i < 12; i++) {
    const lon      = Math.random() * Math.PI * 2;
    const startLat = (Math.random() - 0.5) * Math.PI * 0.8;
    const arcLen   = 0.3 + Math.random() * 0.8;
    const pts      = [];
    for (let j = 0; j <= 40; j++) {
      const lat = startLat + (j / 40) * arcLen;
      pts.push(new THREE.Vector3(
        R2 * Math.cos(lat) * Math.cos(lon),
        R2 * Math.sin(lat),
        R2 * Math.cos(lat) * Math.sin(lon),
      ));
    }
    shell2.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      lineMat(C_DIM, 0.15 + Math.random() * 0.2),
    ));
  }
  orbGroup.add(shell2);

  // ══════════════════════════════════════════════
  // LAYER 4 — INNER CORE: spiral geodesic
  // ══════════════════════════════════════════════
  const innerCore = new THREE.Group();
  const R3 = 0.9;

  for (let s = 0; s < 8; s++) {
    const pts   = [];
    const turns = 3 + Math.random() * 2;
    const phase = (s / 8) * Math.PI * 2;
    for (let i = 0; i <= 300; i++) {
      const tt  = i / 300;
      const lat = tt * Math.PI - Math.PI / 2;
      const lon = tt * turns * Math.PI * 2 + phase;
      pts.push(new THREE.Vector3(
        R3 * Math.cos(lat) * Math.cos(lon),
        R3 * Math.sin(lat),
        R3 * Math.cos(lat) * Math.sin(lon),
      ));
    }
    innerCore.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      lineMat(C_BRIGHT, 0.3 + Math.random() * 0.2),
    ));
  }
  for (let i = -6; i <= 6; i++) {
    innerCore.add(new THREE.Line(latRing(R3, (i / 6) * (Math.PI / 2) * 0.9, 80), lineMat(C_DIM, 0.2)));
  }
  for (let i = 0; i < 12; i++) {
    innerCore.add(new THREE.Line(meridian(R3, (i / 12) * Math.PI * 2, 80), lineMat(C_DIM, 0.15)));
  }
  orbGroup.add(innerCore);

  // ══════════════════════════════════════════════
  // LAYER 5 — INNERMOST CORE: bright hot center
  // ══════════════════════════════════════════════
  const icoGeo     = new THREE.IcosahedronGeometry(0.25, 1);
  const icoEdges   = new THREE.EdgesGeometry(icoGeo);
  const icoWireMat = lineMat(C_HOT, 0.9);
  const icoWire    = new THREE.LineSegments(icoEdges, icoWireMat);
  orbGroup.add(icoWire);

  const coreSphereMat = new THREE.MeshBasicMaterial({
    color: C_HOT, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending,
  });
  const coreSphere = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 16), coreSphereMat);
  orbGroup.add(coreSphere);

  const glowSphereMat = new THREE.MeshBasicMaterial({
    color: C_MID, transparent: true, opacity: 0.04, blending: THREE.AdditiveBlending,
  });
  const glowSphere = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 16), glowSphereMat);
  orbGroup.add(glowSphere);

  // ══════════════════════════════════════════════
  // CODE TEXT SPRITES — dense, drifting
  // ══════════════════════════════════════════════
  const codeSnippets = [
    "sys.init()","0xFF3A","malloc()",">> SCAN","void*","ACK",
    "SYNC OK","ptr_ref","exec()","hash256","::bind","core.0",
    "01101001","10110100",">>> RDY","HEAP 4K","TCP/SYN",
    "mutex.lk","IRQ 0x7","DMA xfer","REG EAX","FAULT 0",
    "kernel.d","pipe |>","chmod +x","fork()","SIGTERM",
    "eth0: UP","AES-256","RSA 4096","TLS 1.3","HTTP/2",
    "latency","200 OK","PATCH /","fn main","use std",
    "impl Orb","async {}","spawn()","arc::new",".unwrap",
  ];

  function makeTextSprite(text, size = 0.08) {
    const c   = document.createElement("canvas");
    c.width   = 256; c.height = 32;
    const ctx = c.getContext("2d");
    ctx.font         = "bold 14px Courier New";
    const alpha      = 0.25 + Math.random() * 0.45;
    ctx.fillStyle    = `rgba(${(80 + Math.random() * 40) | 0},${(200 + Math.random() * 55) | 0},255,${alpha})`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 16);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    sp.scale.set(size * 5, size * 0.7, 1);
    return sp;
  }

  function scatterText(count, sizeFn, rFn, speedRange) {
    const group = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const sp    = makeTextSprite(codeSnippets[Math.floor(Math.random() * codeSnippets.length)], sizeFn());
      const phi   = Math.acos(2 * Math.random() - 1);
      const theta = Math.random() * Math.PI * 2;
      const r     = rFn();
      sp.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      );
      sp.userData = {
        phi, theta, r,
        speed: (speedRange[0] + Math.random() * speedRange[1]) * (Math.random() > 0.5 ? 1 : -1),
      };
      group.add(sp);
    }
    return group;
  }

  const textOuter   = scatterText(1200, () => 0.04 + Math.random() * 0.04, () => R1 + 0.03 + Math.random() * 0.08, [0.0002, 0.0008]);
  const textInner   = scatterText(100,  () => 0.03 + Math.random() * 0.03, () => R3 + 0.02,                         [0.0005, 0.001]);
  const textAmbient = scatterText(400,  () => 0.03,                        () => R3 + 0.2 + Math.random() * (R1 - R3 - 0.3), [0.0003, 0.0006]);
  orbGroup.add(textOuter, textInner, textAmbient);

  // ══════════════════════════════════════════════
  // ORBITING DEBRIS / ROCKS
  // ══════════════════════════════════════════════
  const debrisGeos = [
    new THREE.IcosahedronGeometry(0.012, 0),
    new THREE.IcosahedronGeometry(0.02, 0),
    new THREE.IcosahedronGeometry(0.03, 1),
    new THREE.IcosahedronGeometry(0.008, 0),
    new THREE.TetrahedronGeometry(0.015, 0),
    new THREE.OctahedronGeometry(0.018, 0),
  ];
  const debris = [];
  for (let i = 0; i < 250; i++) {
    const geo  = debrisGeos[Math.floor(Math.random() * debrisGeos.length)];
    const mat  = new THREE.MeshBasicMaterial({
      color: Math.random() > 0.7 ? C_BRIGHT : C_MID,
      transparent: true, opacity: 0.3 + Math.random() * 0.6,
      blending: THREE.AdditiveBlending,
    });
    const mesh   = new THREE.Mesh(geo, mat);
    const orbitR = 1.2 + Math.random() * 4.0;
    const speed  = (0.08 + Math.random() * 0.6) * (Math.random() > 0.5 ? 1 : -1);
    const tiltX  = (Math.random() - 0.5) * Math.PI * 0.9;
    const tiltZ  = (Math.random() - 0.5) * Math.PI * 0.5;
    const phase  = Math.random() * Math.PI * 2;
    mesh.userData = { orbitR, speed, tiltX, tiltZ, phase };
    debris.push(mesh);
    orbGroup.add(mesh);

    if (Math.random() > 0.85) {
      const trailPts = [];
      for (let j = 0; j <= 15; j++) {
        const a = -(j / 15) * 0.3;
        trailPts.push(new THREE.Vector3(
          orbitR * Math.cos(a + phase),
          orbitR * 0.08 * Math.sin(a * 3),
          orbitR * Math.sin(a + phase),
        ));
      }
      mesh.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(trailPts), lineMat(C_FAINT, 0.08)));
    }
  }

  // ══════════════════════════════════════════════
  // DUST PARTICLES
  // ══════════════════════════════════════════════
  const dustCount = 2000;
  const dustPos   = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    const rr    = 0.5 + Math.pow(Math.random(), 0.6) * 7;
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    dustPos[i * 3]     = rr * Math.sin(phi) * Math.cos(theta);
    dustPos[i * 3 + 1] = rr * Math.cos(phi);
    dustPos[i * 3 + 2] = rr * Math.sin(phi) * Math.sin(theta);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.Float32BufferAttribute(dustPos, 3));

  const dotC    = document.createElement("canvas");
  dotC.width    = dotC.height = 64;
  const dCtx    = dotC.getContext("2d");
  const grad    = dCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0,   "rgba(127,232,255,0.9)");
  grad.addColorStop(0.2, "rgba(77,184,255,0.45)");
  grad.addColorStop(0.5, "rgba(42,96,160,0.1)");
  grad.addColorStop(1,   "rgba(20,40,80,0)");
  dCtx.fillStyle = grad;
  dCtx.fillRect(0, 0, 64, 64);

  const dustPoints = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    map: new THREE.CanvasTexture(dotC),
    size: 0.025, transparent: true, opacity: 0.3,
    blending: THREE.AdditiveBlending, depthWrite: false,
    sizeAttenuation: true, color: C_BRIGHT,
  }));
  orbGroup.add(dustPoints);

  // ══════════════════════════════════════════════
  // SCANNING RINGS
  // ══════════════════════════════════════════════
  function makeScanRing(radius, thickness = 0.015) {
    const geo  = new THREE.RingGeometry(radius - thickness, radius + thickness, 120);
    const mat  = new THREE.MeshBasicMaterial({
      color: C_BRIGHT, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = Math.PI / 2;
    return mesh;
  }
  const scanRing1 = makeScanRing(R1, 0.01);
  const scanRing2 = makeScanRing(R1 * 0.7, 0.008);
  orbGroup.add(scanRing1, scanRing2);

  // ══════════════════════════════════════════════
  // HEXAGONAL NODES
  // ══════════════════════════════════════════════
  for (let i = 0; i < 15; i++) {
    const phi   = Math.acos(2 * Math.random() - 1);
    const theta = Math.random() * Math.PI * 2;
    const r     = R1 + 0.02;
    const hexGeo   = new THREE.CircleGeometry(0.03 + Math.random() * 0.02, 6);
    const hexEdges = new THREE.EdgesGeometry(hexGeo);
    const hex      = new THREE.LineSegments(hexEdges, lineMat(C_MID, 0.5));
    hex.position.set(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta),
    );
    hex.lookAt(0, 0, 0);
    outerShell.add(hex);
  }

  // ══════════════════════════════════════════════
  // GESTURE ROTATION STATE
  // Spin is applied directly to orbGroup so it never
  // conflicts with OrbitControls' camera updates.
  // ══════════════════════════════════════════════
  let gestureVelY  = 0;   // current angular velocity Y (from hand gestures)
  let gestureVelX  = 0;   // current angular velocity X
  let gestureRotY  = 0;   // accumulated Y rotation
  let gestureRotX  = 0;   // accumulated X rotation (clamped)
  const FRICTION   = 0.82; // velocity decay per frame — lower = snappier stop

  // ══════════════════════════════════════════════
  // CAMERA CONTROL API (hand-gesture / button driven)
  // ══════════════════════════════════════════════
  const sphericalScratch = new THREE.Spherical();
  const offsetScratch    = new THREE.Vector3();

  function rotateBy(deltaTheta, deltaPhi) {
    // Directly kick the gesture velocity — orbGroup rotation applied in animate()
    // This avoids the OrbitControls overwrite-on-update conflict entirely.
    gestureVelY += deltaTheta;
    gestureVelX += deltaPhi;
  }

  function zoomBy(factor) {
    if (!controls) return;
    offsetScratch.copy(camera.position).sub(controls.target);
    const dist = THREE.MathUtils.clamp(offsetScratch.length() * factor, MIN_DISTANCE, MAX_DISTANCE);
    offsetScratch.setLength(dist);
    camera.position.copy(controls.target).add(offsetScratch);
  }

  function resetView() {
    // Reset camera
    camera.position.copy(HOME_POSITION);
    if (controls) {
      controls.target.set(0, 0, 0);
      camera.lookAt(controls.target);
      controls.update();
    }
    // Reset gesture rotation too
    gestureVelY = 0; gestureVelX = 0;
    gestureRotY = 0; gestureRotX = 0;
    orbGroup.rotation.set(0, 0, 0);
  }

  // ══════════════════════════════════════════════
  // ANIMATION LOOP
  // ══════════════════════════════════════════════
  const clock         = new THREE.Clock();
  let   flickerTimer  = 0;
  let   rafId         = 0;
  let   disposed      = false;

  function animate() {
    if (disposed) return;
    rafId = requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    // Ambient auto-rotate for non-interactive pages
    if (!interactive) {
      orbGroup.rotation.y += 0.0018;
    } else {
      // ── Gesture spin applied to orbGroup (not camera) ────────────────────
      // Velocity decays with friction so the orb coasts to a stop naturally.
      gestureVelY *= FRICTION;
      gestureVelX *= FRICTION;
      gestureRotY += gestureVelY;
      gestureRotX  = THREE.MathUtils.clamp(gestureRotX + gestureVelX, -Math.PI * 0.48, Math.PI * 0.48);
      orbGroup.rotation.y = gestureRotY;
      orbGroup.rotation.x = gestureRotX;
    }

    outerShell.rotation.y += 0.0015;
    outerShell.rotation.x  = Math.sin(t * 0.08) * 0.05;

    panelGroup.rotation.y += 0.0018;
    panelGroup.rotation.x  = Math.sin(t * 0.08 + 0.5) * 0.04;

    shell2.rotation.y -= 0.001;
    shell2.rotation.z  = Math.sin(t * 0.12) * 0.03;

    innerCore.rotation.y -= 0.005;
    innerCore.rotation.z += 0.002;
    innerCore.rotation.x  = Math.cos(t * 0.1) * 0.08;

    icoWire.rotation.x += 0.008;
    icoWire.rotation.y += 0.012;

    // Core pulse
    const wave1   = Math.sin(t * 1.2);
    const wave3   = Math.pow(Math.max(0, Math.sin(t * 0.4)), 5);
    const wave4   = Math.pow(Math.max(0, Math.sin(t * 0.7 + 2)), 8);
    const fadeOut = Math.pow(Math.max(0, Math.sin(t * 0.25)), 3);
    const surge   = wave3 * 1.5 + wave4 * 2.0;

    coreSphere.scale.setScalar(1 + surge + Math.sin(t * 5) * 0.05);
    coreSphereMat.opacity = Math.min(0.6, Math.max(0, (0.08 + wave1 * 0.05 + surge * 0.2) * (1 - fadeOut * 0.95)));

    glowSphere.scale.setScalar(1 + surge * 0.8);
    glowSphereMat.opacity = Math.max(0, (0.03 + surge * 0.08) * (1 - fadeOut * 0.9));

    icoWire.scale.setScalar(1 + surge * 0.6);
    icoWireMat.opacity = Math.min(1, 0.5 + surge * 0.4);

    // Debris
    for (const d of debris) {
      const u = d.userData;
      const a = t * u.speed + u.phase;
      d.position.set(
        u.orbitR * Math.cos(a) * Math.cos(u.tiltX),
        u.orbitR * Math.sin(u.tiltX) * Math.sin(a * 0.8) + Math.sin(a * 0.3 + u.tiltZ) * 0.2,
        u.orbitR * Math.sin(a) * Math.cos(u.tiltZ),
      );
      d.rotation.x += 0.015;
      d.rotation.z += 0.01;
    }

    // Text drift
    for (const [grp, mult] of [[textOuter, 1], [textInner, 2], [textAmbient, 1.2]]) {
      for (const sp of grp.children) {
        const u   = sp.userData;
        u.theta  += u.speed * mult;
        sp.position.set(
          u.r * Math.sin(u.phi) * Math.cos(u.theta),
          u.r * Math.cos(u.phi),
          u.r * Math.sin(u.phi) * Math.sin(u.theta),
        );
      }
    }

    // Scan rings
    const scanY1 = Math.sin(t * 0.4) * R1;
    scanRing1.position.y = scanY1;
    const scanS1 = Math.sqrt(Math.max(0, R1 * R1 - scanY1 * scanY1)) / R1;
    scanRing1.scale.set(scanS1, scanS1, 1);
    scanRing1.material.opacity = 0.2 * scanS1;

    const scanY2 = Math.sin(t * 0.6 + 2) * R3;
    scanRing2.position.y = scanY2;
    const scanS2 = Math.sqrt(Math.max(0, R3 * R3 - scanY2 * scanY2)) / R3;
    scanRing2.scale.set(scanS2, scanS2, 1);
    scanRing2.material.opacity = 0.15 * scanS2;

    dustPoints.rotation.y += 0.0002;

    // Panel flicker
    flickerTimer += 0.016;
    if (flickerTimer > 0.1) {
      flickerTimer = 0;
      for (const p of panelGroup.children) {
        if (Math.random() > 0.95) p.visible = !p.visible;
      }
    }

    bloom.strength = 0.6 + Math.sin(t * 0.8) * 0.1;
    chromaticPass.uniforms.uTime.value = t;

    if (controls) controls.update();
    composer.render();
  }

  animate();

  // ——— RESIZE ———
  function onResize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  }
  window.addEventListener("resize", onResize);

  // ——— CLEANUP ———
  function dispose() {
    disposed = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener("resize", onResize);
    if (controls) controls.dispose();
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat) continue;
        if (mat.map) mat.map.dispose();
        mat.dispose();
      }
    });
    composer.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return { rotateBy, zoomBy, zoomIn: () => zoomBy(0.65), zoomOut: () => zoomBy(1.55), resetView, dispose };
}
