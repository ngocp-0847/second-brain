// Graph view: force-directed layout tự viết trên <canvas> 2D — không dependency.
// Kéo node để dịch, kéo nền để pan, lăn chuột để zoom, click node để mở note.
import { onCleanup, onMount } from "solid-js";
import { api } from "./api";

interface SimNode {
  path: string;
  title: string;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function GraphView(props: { onOpen: (path: string) => void }) {
  let canvasEl!: HTMLCanvasElement;
  let raf = 0;

  onMount(async () => {
    const data = await api.graphData().catch(() => ({ nodes: [], edges: [] }));
    const ctx = canvasEl.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;

    const nodes: SimNode[] = data.nodes.map((n, i) => {
      const angle = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
      const r = 120 + Math.random() * 240;
      return { ...n, x: Math.cos(angle) * r, y: Math.sin(angle) * r, vx: 0, vy: 0 };
    });
    const byPath = new Map(nodes.map((n) => [n.path, n]));
    const edges = data.edges
      .map((e) => ({ a: byPath.get(e.from), b: byPath.get(e.to) }))
      .filter((e): e is { a: SimNode; b: SimNode } => !!e.a && !!e.b);

    // camera
    let scale = 1;
    let ox = 0;
    let oy = 0;
    let cooling = 1;

    const resize = () => {
      const rect = canvasEl.parentElement!.getBoundingClientRect();
      canvasEl.width = rect.width * dpr;
      canvasEl.height = rect.height * dpr;
      canvasEl.style.width = `${rect.width}px`;
      canvasEl.style.height = `${rect.height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvasEl.parentElement!);

    const toWorld = (px: number, py: number) => {
      const rect = canvasEl.getBoundingClientRect();
      return {
        x: (px - rect.left - rect.width / 2 - ox) / scale,
        y: (py - rect.top - rect.height / 2 - oy) / scale,
      };
    };

    const nodeAt = (wx: number, wy: number) =>
      nodes.find((n) => {
        const r = 5 + Math.min(10, n.degree * 1.5);
        return (n.x - wx) ** 2 + (n.y - wy) ** 2 < (r + 3) ** 2;
      });

    // ---- interaction state (khai báo trước vì physics/render đọc tới) ----
    let dragNode: SimNode | undefined;
    let hover: SimNode | undefined;
    let panning = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;

    // ---- physics ----
    const step = () => {
      if (cooling < 0.005) return;
      // đẩy nhau (O(n²) — ổn tới vài nghìn note)
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          if (d2 > 90000) continue;
          const f = 900 / d2;
          const d = Math.sqrt(d2);
          dx /= d;
          dy /= d;
          a.vx += dx * f;
          a.vy += dy * f;
          b.vx -= dx * f;
          b.vy -= dy * f;
        }
      }
      // lò xo theo edge
      for (const { a, b } of edges) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 90) * 0.01;
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
      // hút về tâm + damping
      for (const n of nodes) {
        n.vx -= n.x * 0.0015;
        n.vy -= n.y * 0.0015;
        if (n !== dragNode) {
          n.x += n.vx * cooling;
          n.y += n.vy * cooling;
        }
        n.vx *= 0.85;
        n.vy *= 0.85;
      }
      cooling *= 0.997;
    };

    // ---- render ----
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      const w = canvasEl.width / dpr;
      const h = canvasEl.height / dpr;
      ctx.translate(w / 2 + ox, h / 2 + oy);
      ctx.scale(scale, scale);

      const neighbors = new Set<SimNode>();
      if (hover) {
        for (const { a, b } of edges) {
          if (a === hover) neighbors.add(b);
          if (b === hover) neighbors.add(a);
        }
      }

      ctx.lineWidth = 1 / scale;
      for (const { a, b } of edges) {
        const lit = hover && (a === hover || b === hover);
        ctx.strokeStyle = lit ? "#a48fffaa" : "#3a415a66";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (const n of nodes) {
        const r = 5 + Math.min(10, n.degree * 1.5);
        const lit = n === hover || neighbors.has(n);
        ctx.fillStyle = n === hover ? "#c9b8ff" : lit ? "#a48fff" : "#8b93a7";
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (scale > 0.55 || n.degree >= 3 || lit) {
          ctx.fillStyle = lit ? "#e8eaf2" : "#9aa3b8";
          ctx.font = `${12 / scale}px 'Segoe UI', sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(n.title, n.x, n.y + r + 14 / scale);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };

    const loop = () => {
      step();
      draw();
      raf = requestAnimationFrame(loop);
    };
    loop();

    // ---- interactions ----
    const onDown = (e: MouseEvent) => {
      const w = toWorld(e.clientX, e.clientY);
      dragNode = nodeAt(w.x, w.y);
      panning = !dragNode;
      moved = false;
      lastX = e.clientX;
      lastY = e.clientY;
      cooling = Math.max(cooling, 0.3);
    };
    const onMove = (e: MouseEvent) => {
      const w = toWorld(e.clientX, e.clientY);
      if (dragNode) {
        dragNode.x = w.x;
        dragNode.y = w.y;
        moved = true;
      } else if (panning) {
        ox += e.clientX - lastX;
        oy += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        moved = true;
      } else {
        const h = nodeAt(w.x, w.y);
        if (h !== hover) {
          hover = h;
          canvasEl.style.cursor = h ? "pointer" : "grab";
        }
      }
    };
    const onUp = () => {
      if (dragNode && !moved) props.onOpen(dragNode.path);
      dragNode = undefined;
      panning = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      scale = Math.min(4, Math.max(0.15, scale * factor));
      cooling = Math.max(cooling, 0.05);
    };

    canvasEl.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvasEl.addEventListener("wheel", onWheel, { passive: false });

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvasEl.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvasEl.removeEventListener("wheel", onWheel);
    });
  });

  return (
    <div class="graph-host">
      <canvas ref={canvasEl} />
      <div class="graph-hint">kéo node · lăn chuột zoom · click mở note</div>
    </div>
  );
}
