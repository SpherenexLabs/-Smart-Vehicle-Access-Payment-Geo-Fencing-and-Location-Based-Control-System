import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

const THEMES = {
  'over-voltage': { color: 0xff334f, accent: '#ff334f', symbol: '!', label: 'OVER VOLTAGE' },
  'low-voltage': { color: 0xffa21a, accent: '#f08a00', symbol: '↓', label: 'LOW VOLTAGE' }
};

function AlertScene({ type }) {
  const mount = useRef(null);

  useEffect(() => {
    const host = mount.current;
    const theme = THEMES[type];
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0.3, 6.7);
    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(3, 5, 4);
    scene.add(key);
    const glow = new THREE.PointLight(theme.color, 30, 12);
    glow.position.set(-2, 1, 2);
    scene.add(glow);

    const group = new THREE.Group();
    scene.add(group);
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(2.05, 3.15, 1.05),
      new THREE.MeshPhysicalMaterial({ color: 0xe8f3fb, transparent: true, opacity: 0.32, roughness: 0.08, metalness: 0.15, side: THREE.DoubleSide })
    );
    const charge = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 2.65, 0.78),
      new THREE.MeshStandardMaterial({ color: theme.color, emissive: theme.color, emissiveIntensity: 0.75, roughness: 0.3 })
    );
    const terminal = new THREE.Mesh(
      new THREE.BoxGeometry(0.72, 0.28, 0.65),
      new THREE.MeshStandardMaterial({ color: 0x9eb2c2, metalness: 0.85, roughness: 0.25 })
    );
    terminal.position.y = 1.7;
    group.add(charge, shell, terminal);

    const ringMaterial = new THREE.MeshBasicMaterial({ color: theme.color, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    const rings = [0, 1, 2].map(index => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.22, 64), ringMaterial.clone());
      ring.position.z = -0.6;
      ring.userData.offset = index / 3;
      scene.add(ring);
      return ring;
    });

    const particlesGeometry = new THREE.BufferGeometry();
    const particleCount = 90;
    const positions = new Float32Array(particleCount * 3);
    for (let index = 0; index < particleCount; index += 1) {
      positions[index * 3] = (Math.random() - 0.5) * 5;
      positions[index * 3 + 1] = (Math.random() - 0.5) * 5;
      positions[index * 3 + 2] = (Math.random() - 0.5) * 2;
    }
    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const particles = new THREE.Points(particlesGeometry, new THREE.PointsMaterial({ color: theme.color, size: 0.045, transparent: true, opacity: 0.72 }));
    scene.add(particles);

    const resize = () => {
      const width = host.clientWidth || 320, height = host.clientHeight || 250;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const clock = new THREE.Clock();
    let frame;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      const time = clock.getElapsedTime();
      if (!reduceMotion) {
        group.rotation.y = Math.sin(time * 1.2) * 0.28;
        group.position.y = Math.sin(time * 2) * 0.08;
        charge.scale.setScalar(1 + Math.sin(time * 5) * 0.035);
        particles.rotation.z = time * 0.08;
      }
      rings.forEach(ring => {
        const progress = reduceMotion ? ring.userData.offset : (time * 0.48 + ring.userData.offset) % 1;
        const scale = 0.65 + progress * 1.8;
        ring.scale.setScalar(scale);
        ring.material.opacity = 0.55 * (1 - progress);
      });
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scene.traverse(object => {
        object.geometry?.dispose?.();
        if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => material.dispose());
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
  }, [type]);

  return <div className="safety-alert-scene" ref={mount} aria-hidden="true"/>;
}

export default function SafetyAlert3D({ alert, onClose }) {
  const closeButton = useRef(null);
  const dialog = useRef(null);
  const theme = THEMES[alert.type];

  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = [...dialog.current.querySelectorAll('button, [href], [tabindex="0"]')].filter(element => !element.disabled);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [onClose]);

  return <div className="modal-backdrop safety-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`safety-alert-dialog ${alert.type}`} ref={dialog} role="alertdialog" aria-modal="true" aria-labelledby="safety-alert-title" aria-describedby="safety-alert-detail">
      <button ref={closeButton} className="icon-button safety-close" onClick={onClose} aria-label="Dismiss safety alert">×</button>
      <AlertScene type={alert.type}/>
      <div className="safety-alert-copy">
        <span className="safety-alert-kicker" style={{ color: theme.accent }}>{theme.symbol} &nbsp;LIVE SAFETY ALERT</span>
        <h2 id="safety-alert-title">{theme.label}</h2>
        <strong className="safety-alert-value" style={{ color: theme.accent }}>{alert.value}</strong>
        <p id="safety-alert-detail">{alert.detail}</p>
        <button className="button primary" onClick={onClose}>Acknowledge alert</button>
      </div>
    </section>
  </div>;
}
