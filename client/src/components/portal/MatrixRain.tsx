import { useEffect, useRef } from "react";

/**
 * Subtle matrix rain backdrop (portal + panel Matrix Glass theme).
 * Uses brand orange + matrix green glyphs on a dark void.
 */
export function MatrixRain({ className = "matrix-rain-canvas" }: { className?: string } = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const glyphs = "01アイウエオカキクケコｱｲｳｴｵﾊﾟﾉﾙｽ01#$%<>";
    const colors = ["#f97316", "#fb923c", "#34d399", "#6ee7b7", "#22c55e"];
    let raf = 0;
    let columns = 0;
    let drops: number[] = [];
    let fontSize = 14;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fontSize = w < 640 ? 12 : 14;
      columns = Math.ceil(w / fontSize);
      drops = Array.from({ length: columns }, () => Math.random() * -40);
    };

    const draw = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.fillStyle = "rgba(2, 8, 6, 0.08)";
      ctx.fillRect(0, 0, w, h);
      ctx.font = `${fontSize}px "Space Grotesk", ui-monospace, monospace`;

      for (let i = 0; i < drops.length; i++) {
        const ch = glyphs[Math.floor(Math.random() * glyphs.length)]!;
        const x = i * fontSize;
        const y = drops[i]! * fontSize;
        const isHead = Math.random() > 0.92;
        ctx.fillStyle = isHead
          ? "#fff7ed"
          : colors[Math.floor(Math.random() * colors.length)]!;
        ctx.globalAlpha = isHead ? 0.55 : 0.18 + Math.random() * 0.22;
        ctx.fillText(ch, x, y);
        ctx.globalAlpha = 1;

        if (y > h && Math.random() > 0.975) {
          drops[i] = 0;
        } else {
          drops[i]! += 0.65 + Math.random() * 0.35;
        }
      }

      raf = window.requestAnimationFrame(draw);
    };

    resize();
    // Seed a solid dark base so first frames aren't blank-white.
    ctx.fillStyle = "#020806";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    draw();

    window.addEventListener("resize", resize);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
    />
  );
}
