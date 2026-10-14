import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { cellLabel } from '../lib/model.js';
import { voltageToSoc } from '../lib/firebaseRtdb.js';

const COUNT = 14, PER_ROW = 7, HEIGHT = 2.2, RADIUS = 0.42, GAP_X = 1.25, GAP_Z = 1.5;
const levelColor = p => p < 20 ? '#e5484d' : p < 50 ? '#e99900' : '#00baa5';

// Animated 3D battery pack driven by the fourteen Firebase voltage readings.
export default function Cells3D({ values: voltages = [], onSelect }) {
  const mount = useRef(null);
  const labels = useRef([]);
  const targets = useRef([]);
  const values = Array.from({ length: COUNT }, (_, index) => Math.round(voltageToSoc(voltages[index]) ?? 0));
  targets.current = values;

  useEffect(() => {
    const host = mount.current;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 8, 6);
    scene.add(key);
    const rim = new THREE.PointLight(0x00baa5, 18, 20);
    rim.position.set(-5, 3, -4);
    scene.add(rim);

    const pack = new THREE.Group();
    scene.add(pack);
    const width = (PER_ROW - 1) * GAP_X;
    const base = new THREE.Mesh(new THREE.BoxGeometry(width + 1.4, 0.18, GAP_Z + 1.4), new THREE.MeshStandardMaterial({ color: 0x173450, metalness: 0.4, roughness: 0.5 }));
    base.position.y = -0.09;
    pack.add(base);

    const shellGeo = new THREE.CylinderGeometry(RADIUS, RADIUS, HEIGHT, 40, 1, true);
    const fillGeo = new THREE.CylinderGeometry(RADIUS * 0.86, RADIUS * 0.86, 1, 40);
    fillGeo.translate(0, 0.5, 0); // scale grows upward from the bottom
    const capGeo = new THREE.CylinderGeometry(RADIUS * 0.4, RADIUS * 0.4, 0.14, 24);
    const ringGeo = new THREE.TorusGeometry(RADIUS, 0.035, 8, 40);
    const shellMat = new THREE.MeshPhysicalMaterial({ color: 0xdcecff, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xb8c6d4, metalness: 0.9, roughness: 0.25 });
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x6d87a4, metalness: 0.7, roughness: 0.35 });

    const cells = Array.from({ length: COUNT }, (_, i) => {
      const group = new THREE.Group();
      group.position.set((i % PER_ROW) * GAP_X - width / 2, 0, i < PER_ROW ? -GAP_Z / 2 : GAP_Z / 2);
      const shell = new THREE.Mesh(shellGeo, shellMat);
      shell.position.y = HEIGHT / 2;
      shell.renderOrder = 2;
      const fillMat = new THREE.MeshStandardMaterial({ color: levelColor(targets.current[i]), emissive: levelColor(targets.current[i]), emissiveIntensity: 0.35, roughness: 0.35 });
      const fill = new THREE.Mesh(fillGeo, fillMat);
      fill.position.y = 0.03;
      fill.scale.y = 0.01;
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.y = HEIGHT + 0.07;
      const top = new THREE.Mesh(ringGeo, ringMat), bottom = new THREE.Mesh(ringGeo, ringMat);
      top.rotation.x = bottom.rotation.x = Math.PI / 2;
      top.position.y = HEIGHT; bottom.position.y = 0.02;
      group.add(fill, shell, cap, top, bottom);
      group.userData = { index: i, shown: 0 };
      pack.add(group);
      return { group, fill, fillMat };
    });

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      // Pull the camera back on narrow screens so all 7 columns stay in view.
      const distance = Math.max(9.5, 9.5 * (1.9 / camera.aspect));
      camera.position.set(0, distance * 0.55, distance);
      camera.lookAt(0, 0.9, 0);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    // Hover + click picking
    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
    let hovered = -1;
    const pick = e => {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(cells.map(c => c.group), true)[0];
      let obj = hit?.object;
      while (obj && obj.userData.index === undefined) obj = obj.parent;
      return obj ? obj.userData.index : -1;
    };
    const onMove = e => { hovered = pick(e); renderer.domElement.style.cursor = hovered >= 0 && onSelect ? 'pointer' : 'default'; };
    const onLeave = () => { hovered = -1; };
    const onClick = e => { const i = pick(e); if (i >= 0) onSelect?.(i + 1); };
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerleave', onLeave);
    renderer.domElement.addEventListener('click', onClick);

    const clock = new THREE.Clock(), anchor = new THREE.Vector3(), color = new THREE.Color();
    let frame;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      if (!reduceMotion) pack.rotation.y = Math.sin(t * 0.25) * 0.28;
      const { clientWidth: w, clientHeight: h } = host;
      cells.forEach(({ group, fill, fillMat }, i) => {
        const target = targets.current[i];
        const data = group.userData;
        data.shown += (target - data.shown) * (reduceMotion ? 1 : 0.06);
        fill.scale.y = Math.max(0.01, (data.shown / 100) * (HEIGHT - 0.06));
        color.set(levelColor(data.shown));
        fillMat.color.lerp(color, 0.1);
        fillMat.emissive.lerp(color, 0.1);
        fillMat.emissiveIntensity = 0.3 + (reduceMotion ? 0 : Math.sin(t * 3 + i) * 0.12) + (hovered === i ? 0.45 : 0);
        const lift = hovered === i ? 0.18 : 0;
        group.position.y += (lift - group.position.y) * 0.15;

        const label = labels.current[i];
        if (label) {
          group.getWorldPosition(anchor);
          anchor.y += HEIGHT + 0.45;
          anchor.project(camera);
          label.style.transform = `translate(-50%, -100%) translate(${(anchor.x * 0.5 + 0.5) * w}px, ${(-anchor.y * 0.5 + 0.5) * h}px)`;
          label.firstChild.textContent = `${Math.round(data.shown)}%`;
          label.style.color = levelColor(data.shown);
        }
      });
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerleave', onLeave);
      renderer.domElement.removeEventListener('click', onClick);
      scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); } });
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, [onSelect]);

  const average = Math.round(values.reduce((a, b) => a + b, 0) / COUNT);
  return <div className="cells3d">
    <div className="cells3d-stage" ref={mount} role="img" aria-label={`3D battery pack, 14 cells, average charge ${average}%`}>
      {values.map((_, i) => <span className="cells3d-label" key={i} ref={el => { labels.current[i] = el; }}>
        <b/><small>{cellLabel(i + 1)}</small>
      </span>)}
    </div>
    <div className="cells3d-legend">
      <span><i style={{ background: '#00baa5' }}/>≥ 50%</span>
      <span><i style={{ background: '#e99900' }}/>20–49%</span>
      <span><i style={{ background: '#e5484d' }}/>&lt; 20%</span>
      <span className="cells3d-avg">Average <strong>{average}%</strong></span>
    </div>
  </div>;
}
