import { useEffect, useRef } from 'react';

type NodeKind = 'sat' | 'station' | 'tower';

type NetNode = {
  id: number;
  kind: NodeKind;
  /** Base / orbit center */
  cx: number;
  cy: number;
  /** For sats: orbit radii + phase */
  rx?: number;
  ry?: number;
  phase?: number;
  speed?: number;
  x: number;
  y: number;
};

type Link = {
  a: number;
  b: number;
  hue: 'cyan' | 'amber' | 'orange';
  lag: number;
  speed: number;
};

type Packet = {
  link: number;
  t: number;
  dir: 1 | -1;
  hue: Link['hue'];
};

/**
 * Animated satellites, land stations, and towers exchanging optical
 * signal beams — backdrop for the Orbital Net panel theme.
 */
export function OrbitalNetwork({ className = 'orbital-network-canvas' }: { className?: string } = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    let raf = 0;
    let w = 0;
    let h = 0;
    let t0 = performance.now();
    let stars: { x: number; y: number; r: number; a: number }[] = [];
    let nodes: NetNode[] = [];
    let links: Link[] = [];
    let packets: Packet[] = [];

    const colors = {
      cyan: { stroke: 'rgba(103, 232, 249, 0.55)', glow: 'rgba(34, 211, 238, 0.45)', packet: '#a5f3fc' },
      amber: { stroke: 'rgba(251, 191, 36, 0.5)', glow: 'rgba(251, 191, 36, 0.4)', packet: '#fde68a' },
      orange: { stroke: 'rgba(249, 115, 22, 0.55)', glow: 'rgba(249, 115, 22, 0.42)', packet: '#fdba74' },
    };

    const layout = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      stars = Array.from({ length: Math.floor((w * h) / 14000) + 40 }, () => ({
        x: Math.random() * w,
        y: Math.random() * h * 0.72,
        r: Math.random() * 1.2 + 0.3,
        a: 0.15 + Math.random() * 0.45,
      }));

      const groundY = h * 0.78;
      nodes = [
        {
          id: 0,
          kind: 'sat',
          cx: w * 0.28,
          cy: h * 0.28,
          rx: Math.min(w, h) * 0.1,
          ry: Math.min(w, h) * 0.045,
          phase: 0.2,
          speed: 0.35,
          x: 0,
          y: 0,
        },
        {
          id: 1,
          kind: 'sat',
          cx: w * 0.72,
          cy: h * 0.22,
          rx: Math.min(w, h) * 0.12,
          ry: Math.min(w, h) * 0.05,
          phase: 2.1,
          speed: 0.28,
          x: 0,
          y: 0,
        },
        {
          id: 2,
          kind: 'sat',
          cx: w * 0.52,
          cy: h * 0.16,
          rx: Math.min(w, h) * 0.08,
          ry: Math.min(w, h) * 0.035,
          phase: 4.0,
          speed: 0.42,
          x: 0,
          y: 0,
        },
        { id: 3, kind: 'station', cx: w * 0.18, cy: groundY, x: w * 0.18, y: groundY },
        { id: 4, kind: 'station', cx: w * 0.48, cy: groundY + 6, x: w * 0.48, y: groundY + 6 },
        { id: 5, kind: 'tower', cx: w * 0.78, cy: groundY - 4, x: w * 0.78, y: groundY - 4 },
        { id: 6, kind: 'tower', cx: w * 0.92, cy: groundY + 10, x: w * 0.92, y: groundY + 10 },
        { id: 7, kind: 'station', cx: w * 0.08, cy: groundY + 14, x: w * 0.08, y: groundY + 14 },
      ];

      links = [
        { a: 0, b: 3, hue: 'cyan', lag: 0, speed: 0.22 },
        { a: 0, b: 4, hue: 'orange', lag: 0.4, speed: 0.18 },
        { a: 1, b: 5, hue: 'cyan', lag: 0.15, speed: 0.2 },
        { a: 1, b: 4, hue: 'amber', lag: 0.7, speed: 0.16 },
        { a: 2, b: 4, hue: 'orange', lag: 0.25, speed: 0.24 },
        { a: 2, b: 6, hue: 'cyan', lag: 0.55, speed: 0.19 },
        { a: 3, b: 4, hue: 'amber', lag: 0.1, speed: 0.3 },
        { a: 4, b: 5, hue: 'orange', lag: 0.35, speed: 0.28 },
        { a: 5, b: 6, hue: 'cyan', lag: 0.5, speed: 0.32 },
        { a: 0, b: 1, hue: 'amber', lag: 0.9, speed: 0.12 },
        { a: 1, b: 2, hue: 'cyan', lag: 1.1, speed: 0.14 },
        { a: 7, b: 3, hue: 'orange', lag: 0.2, speed: 0.26 },
      ];

      packets = links.flatMap((link, i) => [
        { link: i, t: (link.lag * 0.37) % 1, dir: 1, hue: link.hue },
        { link: i, t: (link.lag * 0.37 + 0.5) % 1, dir: -1 as const, hue: link.hue },
      ]);
    };

    const updateSats = (now: number) => {
      const sec = now / 1000;
      for (const n of nodes) {
        if (n.kind !== 'sat') continue;
        const ang = (n.phase || 0) + sec * (n.speed || 0.3);
        n.x = n.cx + Math.cos(ang) * (n.rx || 40);
        n.y = n.cy + Math.sin(ang) * (n.ry || 18);
      }
    };

    const drawHorizon = () => {
      const gy = h * 0.76;
      const grad = ctx.createLinearGradient(0, gy - 40, 0, h);
      grad.addColorStop(0, 'rgba(8, 20, 40, 0)');
      grad.addColorStop(0.35, 'rgba(10, 28, 52, 0.55)');
      grad.addColorStop(1, 'rgba(4, 12, 28, 0.85)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, gy - 40, w, h - gy + 40);

      ctx.strokeStyle = 'rgba(125, 211, 252, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      for (let x = 0; x <= w; x += 24) {
        ctx.lineTo(x, gy + Math.sin(x * 0.02) * 2);
      }
      ctx.stroke();
    };

    const drawSatellite = (n: NetNode) => {
      const { x, y } = n;
      ctx.save();
      ctx.translate(x, y);
      // glow
      ctx.fillStyle = 'rgba(125, 211, 252, 0.18)';
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.fill();
      // body
      ctx.fillStyle = 'rgba(226, 232, 240, 0.92)';
      ctx.fillRect(-5, -3.5, 10, 7);
      ctx.strokeStyle = 'rgba(249, 115, 22, 0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-5, -3.5, 10, 7);
      // panels
      ctx.fillStyle = 'rgba(14, 116, 144, 0.85)';
      ctx.fillRect(-16, -2.5, 10, 5);
      ctx.fillRect(6, -2.5, 10, 5);
      ctx.fillStyle = 'rgba(103, 232, 249, 0.35)';
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(-15 + i * 3, -1.5, 2, 3);
        ctx.fillRect(7 + i * 3, -1.5, 2, 3);
      }
      // antenna
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.75)';
      ctx.beginPath();
      ctx.moveTo(0, -3.5);
      ctx.lineTo(0, -10);
      ctx.stroke();
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(0, -11, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const drawStation = (n: NetNode, pulse: number) => {
      const { x, y } = n;
      ctx.save();
      ctx.translate(x, y);
      // dish
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(0, -10, 12, 5, -0.35, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(103, 232, 249, ${0.35 + pulse * 0.35})`;
      ctx.beginPath();
      ctx.ellipse(0, -10, 8, 3.2, -0.35, 0, Math.PI * 2);
      ctx.stroke();
      // mount
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.8)';
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(0, 0);
      ctx.lineTo(-6, 8);
      ctx.moveTo(0, 0);
      ctx.lineTo(6, 8);
      ctx.stroke();
      // base pad
      ctx.fillStyle = 'rgba(30, 58, 90, 0.7)';
      ctx.fillRect(-10, 6, 20, 4);
      ctx.restore();
    };

    const drawTower = (n: NetNode, pulse: number) => {
      const { x, y } = n;
      ctx.save();
      ctx.translate(x, y);
      ctx.strokeStyle = 'rgba(203, 213, 225, 0.85)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-7, 10);
      ctx.lineTo(0, -28);
      ctx.lineTo(7, 10);
      ctx.moveTo(-4, 0);
      ctx.lineTo(4, 0);
      ctx.moveTo(-5.5, 6);
      ctx.lineTo(5.5, 6);
      ctx.stroke();
      // beacon
      const br = 2.2 + pulse * 1.4;
      ctx.fillStyle = `rgba(249, 115, 22, ${0.55 + pulse * 0.4})`;
      ctx.beginPath();
      ctx.arc(0, -28, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(251, 191, 36, ${0.2 + pulse * 0.25})`;
      ctx.beginPath();
      ctx.arc(0, -28, br * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const drawLink = (a: NetNode, b: NetNode, hue: Link['hue'], phase: number) => {
      const c = colors[hue];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 - Math.min(60, Math.hypot(a.x - b.x, a.y - b.y) * 0.18);

      ctx.save();
      ctx.strokeStyle = c.stroke;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 8]);
      ctx.lineDashOffset = -phase * 40;
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx, my, b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;

      // soft beam wash
      ctx.strokeStyle = c.stroke.replace(/[\d.]+\)$/, '0.12)');
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx, my, b.x, b.y);
      ctx.stroke();
      ctx.restore();
    };

    const pointOnLink = (a: NetNode, b: NetNode, t: number) => {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 - Math.min(60, Math.hypot(a.x - b.x, a.y - b.y) * 0.18);
      const u = 1 - t;
      return {
        x: u * u * a.x + 2 * u * t * mx + t * t * b.x,
        y: u * u * a.y + 2 * u * t * my + t * t * b.y,
      };
    };

    const drawPacket = (p: Packet) => {
      const link = links[p.link]!;
      const a = nodes[link.a]!;
      const b = nodes[link.b]!;
      const tt = p.dir === 1 ? p.t : 1 - p.t;
      const { x, y } = pointOnLink(a, b, tt);
      const c = colors[p.hue];
      ctx.save();
      ctx.fillStyle = c.packet;
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      // trailing spark
      const trail = pointOnLink(a, b, Math.max(0, tt - 0.04 * p.dir));
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.arc(trail.x, trail.y, 1.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const frame = (now: number) => {
      const elapsed = (now - t0) / 1000;
      ctx.clearRect(0, 0, w, h);

      // deep space wash
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#020617');
      sky.addColorStop(0.55, '#061528');
      sky.addColorStop(1, '#030b18');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);

      // stars
      for (const s of stars) {
        const tw = reduceMotion ? s.a : s.a * (0.65 + 0.35 * Math.sin(elapsed * 1.4 + s.x));
        ctx.fillStyle = `rgba(248, 250, 252, ${tw})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // faint orbital rings
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.07)';
      ctx.lineWidth = 1;
      for (const n of nodes) {
        if (n.kind !== 'sat') continue;
        ctx.beginPath();
        ctx.ellipse(n.cx, n.cy, n.rx || 40, n.ry || 18, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      drawHorizon();
      if (!reduceMotion) updateSats(now);
      else {
        for (const n of nodes) {
          if (n.kind === 'sat') {
            n.x = n.cx + (n.rx || 40) * 0.6;
            n.y = n.cy;
          }
        }
      }

      for (let i = 0; i < links.length; i++) {
        const link = links[i]!;
        drawLink(nodes[link.a]!, nodes[link.b]!, link.hue, reduceMotion ? link.lag : elapsed * link.speed + link.lag);
      }

      if (!reduceMotion) {
        for (const p of packets) {
          const link = links[p.link]!;
          p.t = (p.t + link.speed * 0.016) % 1;
          drawPacket(p);
        }
      }

      const pulse = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(elapsed * 2.4);
      for (const n of nodes) {
        if (n.kind === 'sat') drawSatellite(n);
        else if (n.kind === 'station') drawStation(n, pulse);
        else drawTower(n, pulse);
      }

      raf = window.requestAnimationFrame(frame);
    };

    layout();
    t0 = performance.now();
    raf = window.requestAnimationFrame(frame);
    window.addEventListener('resize', layout);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', layout);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
