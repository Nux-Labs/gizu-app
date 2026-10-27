import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

export interface ParticleDotOrbProps {
  className?: string;
  size?: number;
  speed?: number;
  color?: string;
  /** 0 = sphere, 1 = fully scattered */
  burst?: boolean;
  /** camera distance, larger = smaller orb inside its container */
  distance?: number;
  /** how far particles fly on burst */
  spread?: number;
  /** dot size multiplier */
  dotScale?: number;
  /** how many dots on the sphere */
  count?: number;
}

const particleVertexShader = `
uniform float uTime;
uniform float uBurst;
uniform float uSpread;
uniform float uDotScale;
attribute float aSize;
attribute vec3 aDir;
varying float vAlpha;

vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2  C = vec2(1.0/6.0, 1.0/3.0);
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3  ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z *ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

void main() {
  vec3 norm = normalize(position);
  float n = snoise(norm * 1.6 + vec3(0.0, uTime * 0.4, 0.0)) * 0.05;
  vec3 displaced = position + norm * n + aDir * uBurst * uSpread;

  vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  gl_PointSize = aSize * uDotScale * (13.5 / -mvPosition.z) * (1.0 + uBurst * 0.6);
  vAlpha = (smoothstep(-1.1, 1.0, norm.z) * 0.72 + 0.28) * (1.0 - smoothstep(0.35, 1.0, uBurst));
}
`;

const particleFragmentShader = `
uniform vec3 uColor;
varying float vAlpha;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);
  if (dist > 0.5) discard;
  
  float alpha = smoothstep(0.5, 0.18, dist) * vAlpha;
  gl_FragColor = vec4(uColor, alpha);
}
`;

export default function ParticleDotOrb({
  className = '',
  size = 42,
  speed = 1.0,
  color = '#7ce8f2',
  burst = false,
  distance = 4.4,
  spread = 5.0,
  dotScale = 1,
  count = 190,
}: ParticleDotOrbProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const prevPointerRef = useRef({ x: 0, y: 0 });
  const rotationVelocityRef = useRef({ x: 0, y: 0.0035 });
  const burstRef = useRef(false);
  const burstTRef = useRef(0);
  burstRef.current = burst;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || size;
    const height = container.clientHeight || size;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 100);
    camera.position.set(0, 0, distance);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    // ponytail: updateStyle=false -> canvas css ile inset-0, merkez her zaman kabin merkezi
    renderer.setSize(width, height, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.5));
    const canvasEl = renderer.domElement;
    canvasEl.style.position = 'absolute';
    canvasEl.style.inset = '0';
    canvasEl.style.width = '100%';
    canvasEl.style.height = '100%';
    canvasEl.style.display = 'block';
    container.appendChild(canvasEl);

    const group = new THREE.Group();
    scene.add(group);

    // Fibonacci sphere distribution
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const dirs = new Float32Array(count * 3);

    const phi = Math.PI * (3 - Math.sqrt(5));
    const radius = 1.15;

    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2;
      const radiusAtY = Math.sqrt(1 - y * y);
      const theta = phi * i;

      positions[i * 3] = Math.cos(theta) * radiusAtY * radius;
      positions[i * 3 + 1] = y * radius;
      positions[i * 3 + 2] = Math.sin(theta) * radiusAtY * radius;

      sizes[i] = 0.85 + Math.random() * 0.5;

      // ponytail: dagilma yonu = normal + hafif rastgelelik
      const jitter = 0.45;
      const dx = positions[i * 3] / radius + (Math.random() - 0.5) * jitter;
      const dy = positions[i * 3 + 1] / radius + (Math.random() - 0.5) * jitter;
      const dz = positions[i * 3 + 2] / radius + (Math.random() - 0.5) * jitter;
      const len = Math.hypot(dx, dy, dz) || 1;
      const spread = 0.6 + Math.random() * 0.8;
      dirs[i * 3] = (dx / len) * spread;
      dirs[i * 3 + 1] = (dy / len) * spread;
      dirs[i * 3 + 2] = (dz / len) * spread;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));

    const material = new THREE.ShaderMaterial({
      vertexShader: particleVertexShader,
      fragmentShader: particleFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBurst: { value: 0 },
        uSpread: { value: spread },
        uDotScale: { value: dotScale },
        uColor: { value: new THREE.Color(color) },
      },
      transparent: true,
      depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    group.add(points);

    let animationFrameId: number;
    const clock = new THREE.Clock();

    // the burst runs on time, not on frames, so it lands the same on a 60hz
    // panel, a 120hz one and a frame that took too long
    let lastT = performance.now();

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      const elapsedTime = clock.getElapsedTime() * speed;

      const now = performance.now();
      const dt = Math.min((now - lastT) / 1000, 0.05);
      lastT = now;

      const duration = burstRef.current ? 1.5 : 0.55;
      burstTRef.current = Math.min(
        1,
        Math.max(0, burstTRef.current + (burstRef.current ? dt : -dt) / duration),
      );
      const p = burstTRef.current;
      material.uniforms.uTime.value = elapsedTime * 1.4;
      // ease out on the way apart, ease in and out on the way back
      material.uniforms.uBurst.value = burstRef.current
        ? 1 - Math.pow(1 - p, 3)
        : p * p * (3 - 2 * p);

      if (!isDraggingRef.current) {
        group.rotation.y += rotationVelocityRef.current.y;
        group.rotation.x += rotationVelocityRef.current.x;
        rotationVelocityRef.current.y = THREE.MathUtils.lerp(rotationVelocityRef.current.y, 0.0035, 0.04);
        rotationVelocityRef.current.x = THREE.MathUtils.lerp(rotationVelocityRef.current.x, 0.0, 0.04);
      }

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || size;
      const h = container.clientHeight || size;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    const onPointerDown = (e: PointerEvent) => {
      isDraggingRef.current = true;
      prevPointerRef.current = { x: e.clientX, y: e.clientY };
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDraggingRef.current) return;
      const dx = e.clientX - prevPointerRef.current.x;
      const dy = e.clientY - prevPointerRef.current.y;
      prevPointerRef.current = { x: e.clientX, y: e.clientY };

      group.rotation.y += dx * 0.01;
      group.rotation.x += dy * 0.01;
      rotationVelocityRef.current = { x: dy * 0.003, y: dx * 0.003 };
    };

    const onPointerUp = () => {
      isDraggingRef.current = false;
    };

    container.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, [size, speed, color, distance, spread, dotScale, count]);

  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div ref={containerRef} className="relative h-full w-full" />
    </div>
  );
}
