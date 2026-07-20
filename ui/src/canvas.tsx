// Canvas: bảng tự do tương thích định dạng JSON Canvas 1.0 (jsoncanvas.org) của Obsidian.
// - Đủ 4 loại node: text / file / link / group; z-order theo thứ tự mảng (spec)
// - Edge: fromSide/toSide 4 cạnh, fromEnd/toEnd, color, label; kéo lại 2 đầu khi chọn
// - Pan: kéo nền hoặc lăn chuột (shift = ngang) · zoom: Ctrl+lăn về phía con trỏ
// - Mở file là tự fit viewport vào nội dung; field lạ trong file được giữ nguyên khi lưu
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api } from "./api";

export interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  color?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: string;
  toSide?: string;
  fromEnd?: string; // "none" (mặc định) | "arrow"
  toEnd?: string; // "none" | "arrow" (mặc định)
  color?: string;
  label?: string;
}

interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

type Side = "left" | "right" | "top" | "bottom";
type Anchor = { x: number; y: number; dx: number; dy: number };

const uid = () => Math.random().toString(36).slice(2, 10);

// Bảng màu preset chuẩn JSON Canvas ("1".."6"), tông hợp dark theme.
const PALETTE: Record<string, string> = {
  "1": "#e0876a", // đỏ
  "2": "#e8a06a", // cam
  "3": "#e8c76a", // vàng
  "4": "#9ece8f", // lục
  "5": "#6ac4e0", // lam
  "6": "#a48fff", // tím
};

const EDGE_DEFAULT = "#4a5170";
const EDGE_SELECTED = "#a48fff";

// ---- text card: URL trần, [label](url), [[wikilink]] bấm được (chỉ khâu hiển thị,
// nội dung text giữ nguyên trong file .canvas — tương thích Obsidian) ----
const LINKIFY =
  /(!?\[\[([^\[\]]+?)\]\])|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>"')\]]+)/g;

type LinkPart =
  | { t: "text"; s: string }
  | { t: "url"; href: string; label: string }
  | { t: "wiki"; target: string; label: string };

function LinkifiedText(props: { text: string; onOpenNote: (path: string) => void }) {
  const parts = createMemo<LinkPart[]>(() => {
    const out: LinkPart[] = [];
    const text = props.text;
    let last = 0;
    for (const m of text.matchAll(LINKIFY)) {
      if (m.index! > last) out.push({ t: "text", s: text.slice(last, m.index) });
      if (m[1]) {
        const inner = m[2];
        const pipe = inner.indexOf("|");
        const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).split("#")[0].trim();
        out.push({ t: "wiki", target, label: pipe >= 0 ? inner.slice(pipe + 1) : inner });
      } else if (m[3]) {
        out.push({ t: "url", href: m[5], label: m[4] });
      } else {
        out.push({ t: "url", href: m[6], label: m[6] });
      }
      last = m.index! + m[0].length;
    }
    if (last < text.length) out.push({ t: "text", s: text.slice(last) });
    return out;
  });

  const openWiki = async (target: string) => {
    const p = await api.resolveLink(target).catch(() => null);
    if (p) props.onOpenNote(p);
  };

  return (
    <For each={parts()}>
      {(p) =>
        p.t === "text" ? (
          <span>{p.s}</span>
        ) : p.t === "url" ? (
          <a
            class="canvas-link"
            href={p.href}
            title={p.href}
            onMouseDown={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              window.open(p.href, "_blank");
            }}
          >
            {p.label}
          </a>
        ) : (
          <a
            class="canvas-link canvas-link-wiki"
            title={`Mở "${p.target}"`}
            onMouseDown={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openWiki(p.target);
            }}
          >
            {p.label}
          </a>
        )
      }
    </For>
  );
}

// ---- ảnh trong canvas: file node trỏ tới ảnh sẽ render như Obsidian ----
const IMG_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
const IMG_RE = new RegExp(`\\.(${IMG_EXTS.join("|")})$`, "i");
const isImagePath = (p?: string) => !!p && IMG_RE.test(p);
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
};

// Cache data-url theo path để không đọc lại file mỗi lần re-render.
const imgCache = new Map<string, Promise<string>>();
const loadImage = (path: string) => {
  let p = imgCache.get(path);
  if (!p) {
    const ext = path.split(".").pop()!.toLowerCase();
    p = api.readAsset(path).then((b64) => `data:${MIME[ext] ?? "image/png"};base64,${b64}`);
    imgCache.set(path, p);
  }
  return p;
};

function CanvasImage(props: { path: string }) {
  const [src, setSrc] = createSignal<string | null>(null);
  loadImage(props.path).then(setSrc).catch(() => {});
  return (
    <Show when={src()} fallback={<div class="canvas-file-hint">đang tải ảnh…</div>}>
      <img class="canvas-img" src={src()!} draggable={false} alt={props.path} />
    </Show>
  );
}

const resolveColor = (c?: string) => (c ? PALETTE[c] ?? (c.startsWith("#") ? c : null) : null);
const cardColor = (n: CanvasNode) => resolveColor(n.color);

const IconTextCard = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M7.5 9.5h9M7.5 13h9M7.5 16.5h5" />
  </svg>
);

const IconNoteCard = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5L14 3.5Z" />
    <path d="M14 3.5V8.5H19" />
  </svg>
);

const IconImage = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M20 15.5 15.5 11l-7 8" />
  </svg>
);

const IconTrash = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <path d="M4.5 6.5h15M9.5 6V4.5h5V6M7 6.5l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4l.8-12" />
    <path d="M10 10.5v6M14 10.5v6" />
  </svg>
);

export function CanvasView(props: {
  path: string;
  onOpenNote: (path: string) => void;
  requestNotePick: (cb: (path: string) => void) => void;
}) {
  const [doc, setDoc] = createSignal<CanvasDoc>({ nodes: [], edges: [] });
  const [scale, setScale] = createSignal(1);
  const [ox, setOx] = createSignal(0);
  const [oy, setOy] = createSignal(0);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [selectedEdge, setSelectedEdge] = createSignal<string | null>(null);
  const [selectedCard, setSelectedCard] = createSignal<string | null>(null);
  // Đang kéo dây: đầu cố định + đầu di động (tạo edge mới hoặc dời một đầu edge cũ).
  const [linking, setLinking] = createSignal<{
    fixedNode: string;
    fixedSide?: string;
    movingEnd: "from" | "to";
    edgeId?: string;
    x: number;
    y: number;
  } | null>(null);
  let host!: HTMLDivElement;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(
      () => api.writeNote(props.path, JSON.stringify(doc(), null, "\t")).catch(() => {}),
      600,
    );
  };

  const mutate = (f: (d: CanvasDoc) => CanvasDoc) => {
    setDoc(f(doc()));
    scheduleSave();
  };

  /** Đưa viewport về giữa nội dung, zoom vừa khít (canvas Obsidian hay nằm xa gốc tọa độ). */
  const fitView = () => {
    const ns = doc().nodes;
    if (ns.length === 0 || !host) return;
    const pad = 60;
    const minX = Math.min(...ns.map((n) => n.x)) - pad;
    const minY = Math.min(...ns.map((n) => n.y)) - pad;
    const maxX = Math.max(...ns.map((n) => n.x + n.width)) + pad;
    const maxY = Math.max(...ns.map((n) => n.y + n.height)) + pad;
    const s = Math.max(
      0.15,
      Math.min(1, host.clientWidth / (maxX - minX), host.clientHeight / (maxY - minY)),
    );
    setScale(s);
    setOx((host.clientWidth - (maxX - minX) * s) / 2 - minX * s);
    setOy((host.clientHeight - (maxY - minY) * s) / 2 - minY * s);
  };

  onMount(async () => {
    try {
      const raw = await api.readNote(props.path);
      const parsed = JSON.parse(raw);
      setDoc({ nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] });
    } catch {
      setDoc({ nodes: [], edges: [] });
    }
    fitView();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLinking(null);
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (editing()) return;
      if (selectedEdge()) {
        mutate((d) => ({ ...d, edges: d.edges.filter((x) => x.id !== selectedEdge()) }));
        setSelectedEdge(null);
      } else if (selectedCard()) {
        removeCard(selectedCard()!);
        setSelectedCard(null);
      }
    };
    window.addEventListener("keydown", onKey);
    // Ctrl+V dán ảnh từ clipboard → lưu vào assets/ của vault rồi thêm card ảnh.
    const onPaste = async (e: ClipboardEvent) => {
      if (editing()) return;
      const ae = document.activeElement;
      if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return;
      const files = e.clipboardData?.files;
      if (!files?.length) return;
      for (const f of files) {
        if (!f.type.startsWith("image/")) continue;
        e.preventDefault();
        try {
          const buf = new Uint8Array(await f.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 0x8000) {
            bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          }
          const ext = (f.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
          const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
          const name = f.name && !/^image\.\w+$/i.test(f.name) ? f.name : `Pasted image ${stamp}.${ext}`;
          await addImageNode(await api.saveAsset(name, btoa(bin)));
        } catch (err) {
          console.error("paste ảnh thất bại:", err);
        }
      }
    };
    window.addEventListener("paste", onPaste);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    });
  });

  const toWorld = (clientX: number, clientY: number) => {
    const rect = host.getBoundingClientRect();
    return {
      x: (clientX - rect.left - ox()) / scale(),
      y: (clientY - rect.top - oy()) / scale(),
    };
  };

  // ---- pan / zoom / tạo card ----
  let panning = false;
  let lastX = 0;
  let lastY = 0;

  /** Chỗ bấm có phải nền trống không (card/toolbar tự stopPropagation, nhưng plane phủ kín host). */
  const isBackground = (t: EventTarget | null) =>
    !(t instanceof Element && t.closest(".canvas-card, .canvas-group, .card-toolbar, .canvas-toolbar"));

  const onBgDown = (e: MouseEvent) => {
    if (!isBackground(e.target)) return;
    setSelectedEdge(null);
    setSelectedCard(null);
    panning = true;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onMove = (e: MouseEvent) => {
    const l = linking();
    if (l) {
      const w = toWorld(e.clientX, e.clientY);
      setLinking({ ...l, x: w.x, y: w.y });
    } else if (panning) {
      setOx(ox() + e.clientX - lastX);
      setOy(oy() + e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
    } else if (dragging) {
      const w = toWorld(e.clientX, e.clientY);
      const byId = new Map(dragging.map((g) => [g.id, g]));
      mutate((d) => ({
        ...d,
        nodes: d.nodes.map((n) => {
          const g = byId.get(n.id);
          return g ? { ...n, x: Math.round(w.x - g.dx), y: Math.round(w.y - g.dy) } : n;
        }),
      }));
    }
  };
  const onUp = (e: MouseEvent) => {
    const l = linking();
    if (l) {
      const el = e.target instanceof Element ? e.target.closest("[data-node-id]") : null;
      const toId = el?.getAttribute("data-node-id");
      const target = toId ? doc().nodes.find((n) => n.id === toId) : undefined;
      if (target && toId && toId !== l.fixedNode) {
        const side = nearestSide(target, l.x, l.y);
        if (l.edgeId) {
          // Dời một đầu của edge có sẵn.
          mutate((d) => ({
            ...d,
            edges: d.edges.map((x) =>
              x.id !== l.edgeId
                ? x
                : l.movingEnd === "to"
                  ? { ...x, toNode: toId, toSide: side }
                  : { ...x, fromNode: toId, fromSide: side },
            ),
          }));
        } else if (!doc().edges.some((x) => x.fromNode === l.fixedNode && x.toNode === toId)) {
          mutate((d) => ({
            ...d,
            edges: [
              ...d.edges,
              { id: uid(), fromNode: l.fixedNode, toNode: toId, fromSide: l.fixedSide, toSide: side },
            ],
          }));
        }
      }
      setLinking(null);
    }
    panning = false;
    dragging = null;
  };
  const clampScale = (s: number) => Math.min(3, Math.max(0.15, s));
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey) {
      // Zoom về phía con trỏ (giống Obsidian).
      const rect = host.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const s0 = scale();
      const s1 = clampScale(s0 * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      setOx(px - ((px - ox()) * s1) / s0);
      setOy(py - ((py - oy()) * s1) / s0);
      setScale(s1);
    } else if (e.shiftKey) {
      // Chromium tự hoán deltaY → deltaX khi giữ Shift, nên lấy delta nào khác 0.
      setOx(ox() - (e.deltaX || e.deltaY));
    } else {
      // Lăn chuột = pan (Obsidian behavior); trackpad có deltaX thì pan 2 chiều.
      setOx(ox() - e.deltaX);
      setOy(oy() - e.deltaY);
    }
  };
  const newTextCard = (wx: number, wy: number) => {
    const id = uid();
    mutate((d) => ({
      ...d,
      nodes: [
        ...d.nodes,
        { id, type: "text", x: Math.round(wx) - 130, y: Math.round(wy) - 45, width: 260, height: 90, text: "" },
      ],
    }));
    setEditing(id);
    setSelectedCard(id);
  };
  const onDblClick = (e: MouseEvent) => {
    if (!isBackground(e.target)) return;
    const w = toWorld(e.clientX, e.clientY);
    newTextCard(w.x, w.y);
  };

  // ---- kéo card (group kéo theo mọi node nằm trọn bên trong, giống Obsidian) ----
  let dragging: { id: string; dx: number; dy: number }[] | null = null;
  const onCardDown = (e: MouseEvent, n: CanvasNode) => {
    if (editing() === n.id) return;
    e.stopPropagation();
    setSelectedEdge(null);
    setSelectedCard(n.id);
    const w = toWorld(e.clientX, e.clientY);
    const grabbed = [n];
    if (n.type === "group") {
      for (const m of doc().nodes) {
        if (
          m.id !== n.id &&
          m.x >= n.x &&
          m.y >= n.y &&
          m.x + m.width <= n.x + n.width &&
          m.y + m.height <= n.y + n.height
        ) {
          grabbed.push(m);
        }
      }
    }
    dragging = grabbed.map((m) => ({ id: m.id, dx: w.x - m.x, dy: w.y - m.y }));
  };

  const startLink = (e: MouseEvent, n: CanvasNode, side: Side) => {
    e.stopPropagation();
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    setLinking({ fixedNode: n.id, fixedSide: side, movingEnd: "to", x: w.x, y: w.y });
  };

  /** Nhấc một đầu của edge đang chọn để nối lại chỗ khác. */
  const grabEdgeEnd = (e: MouseEvent, edge: CanvasEdge, end: "from" | "to") => {
    e.stopPropagation();
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    setLinking(
      end === "to"
        ? { fixedNode: edge.fromNode, fixedSide: edge.fromSide, movingEnd: "to", edgeId: edge.id, x: w.x, y: w.y }
        : { fixedNode: edge.toNode, fixedSide: edge.toSide, movingEnd: "from", edgeId: edge.id, x: w.x, y: w.y },
    );
  };

  /** Thêm card ảnh ở giữa viewport, kích thước theo ảnh thật (tối đa 420px mỗi chiều). */
  const addImageNode = async (rel: string) => {
    let w = 320;
    let h = 240;
    const src = await loadImage(rel).catch(() => null);
    if (src) {
      const dims = await new Promise<{ w: number; h: number } | null>((res) => {
        const im = new Image();
        im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => res(null);
        im.src = src;
      });
      if (dims && dims.w > 0 && dims.h > 0) {
        const k = Math.min(1, 420 / dims.w, 420 / dims.h);
        w = Math.round(dims.w * k);
        h = Math.round(dims.h * k);
      }
    }
    const rect = host.getBoundingClientRect();
    const c = toWorld(rect.left + host.clientWidth / 2, rect.top + host.clientHeight / 2);
    const id = uid();
    mutate((d) => ({
      ...d,
      nodes: [
        ...d.nodes,
        { id, type: "file", x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2), width: w, height: h, file: rel },
      ],
    }));
    setSelectedCard(id);
  };

  const insertImage = async () => {
    const f = await openDialog({
      title: "Chọn ảnh để chèn",
      filters: [{ name: "Ảnh", extensions: IMG_EXTS }],
    });
    if (typeof f !== "string") return;
    try {
      await addImageNode(await api.importAsset(f));
    } catch (err) {
      console.error("chèn ảnh thất bại:", err);
    }
  };

  const addNoteCard = () =>
    props.requestNotePick((path) => {
      const rect = host.getBoundingClientRect();
      const w = toWorld(rect.left + host.clientWidth / 2, rect.top + host.clientHeight / 2);
      mutate((d) => ({
        ...d,
        nodes: [
          ...d.nodes,
          { id: uid(), type: "file", x: Math.round(w.x) - 150, y: Math.round(w.y) - 70, width: 300, height: 140, file: path },
        ],
      }));
    });

  const removeCard = (id: string) =>
    mutate((d) => ({
      nodes: d.nodes.filter((n) => n.id !== id),
      edges: d.edges.filter((e) => e.fromNode !== id && e.toNode !== id),
    }));

  const setColor = (id: string, color: string | undefined) =>
    mutate((d) => ({
      ...d,
      nodes: d.nodes.map((n) => (n.id === id ? { ...n, color } : n)),
    }));

  const nodeCenter = (nodeId: string) => {
    const n = doc().nodes.find((x) => x.id === nodeId);
    return n ? { x: n.x + n.width / 2, y: n.y + n.height / 2 } : { x: 0, y: 0 };
  };

  /** Cạnh gần điểm (x,y) nhất của card, tính theo tỉ lệ so với tâm. */
  const nearestSide = (n: CanvasNode, x: number, y: number): Side => {
    const rx = (x - (n.x + n.width / 2)) / n.width;
    const ry = (y - (n.y + n.height / 2)) / n.height;
    return Math.abs(rx) > Math.abs(ry) ? (rx < 0 ? "left" : "right") : ry < 0 ? "top" : "bottom";
  };

  /** Điểm nối = trung điểm một trong 4 cạnh, kèm pháp tuyến hướng ra ngoài.
   *  Side thiếu (spec cho phép) → tự chọn cạnh hướng về `towards`. */
  const anchor = (nodeId: string, side?: string, towards?: { x: number; y: number }): Anchor => {
    const n = doc().nodes.find((x) => x.id === nodeId);
    if (!n) return { x: 0, y: 0, dx: 0, dy: 0 };
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    const s: Side =
      side === "left" || side === "right" || side === "top" || side === "bottom"
        ? side
        : towards
          ? nearestSide(n, towards.x, towards.y)
          : "right";
    switch (s) {
      case "left":
        return { x: n.x, y: cy, dx: -1, dy: 0 };
      case "right":
        return { x: n.x + n.width, y: cy, dx: 1, dy: 0 };
      case "top":
        return { x: cx, y: n.y, dx: 0, dy: -1 };
      case "bottom":
        return { x: cx, y: n.y + n.height, dx: 0, dy: 1 };
    }
  };

  /** Bezier giữa hai anchor, uốn theo pháp tuyến cạnh; kèm trung điểm cho label. */
  const edgeGeom = (a: Anchor, b: Anchor) => {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.min(160, Math.max(40, dist / 2));
    // Anchor không có hướng (đầu dây đang kéo theo chuột) → uốn ngang về phía đầu kia.
    const [adx, ady] = a.dx || a.dy ? [a.dx, a.dy] : [Math.sign(b.x - a.x) || 1, 0];
    const [bdx, bdy] = b.dx || b.dy ? [b.dx, b.dy] : [-(Math.sign(b.x - a.x) || 1), 0];
    const c1 = { x: a.x + adx * k, y: a.y + ady * k };
    const c2 = { x: b.x + bdx * k, y: b.y + bdy * k };
    return {
      d: `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`,
      mx: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8,
      my: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8,
    };
  };

  const edgeAnchors = (e: CanvasEdge): [Anchor, Anchor] => [
    anchor(e.fromNode, e.fromSide, nodeCenter(e.toNode)),
    anchor(e.toNode, e.toSide, nodeCenter(e.fromNode)),
  ];

  const edgeStroke = (e: CanvasEdge) =>
    selectedEdge() === e.id ? EDGE_SELECTED : resolveColor(e.color) ?? EDGE_DEFAULT;

  // Mỗi màu edge một <marker> riêng (SVG marker không ăn màu stroke của path).
  const markerColors = createMemo(() => {
    const set = new Set([EDGE_DEFAULT, EDGE_SELECTED]);
    for (const e of doc().edges) {
      const c = resolveColor(e.color);
      if (c) set.add(c);
    }
    return [...set];
  });
  const markerId = (c: string) => `arw-${c.replace(/[^a-zA-Z0-9]/g, "")}`;

  const selectedEdgeObj = () => doc().edges.find((x) => x.id === selectedEdge());

  return (
    <div
      ref={host}
      class="canvas-host"
      onMouseDown={onBgDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onWheel={onWheel}
      onDblClick={onDblClick}
    >
      <div
        class="canvas-plane"
        style={{ transform: `translate(${ox()}px, ${oy()}px) scale(${scale()})` }}
      >
        <svg class="canvas-edges">
          <defs>
            <For each={markerColors()}>
              {(c) => (
                <marker
                  id={markerId(c)}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 9 5 L 0 9 z" fill={c} />
                </marker>
              )}
            </For>
          </defs>
          <For each={doc().edges}>
            {(e) => {
              const geom = () => {
                const [a, b] = edgeAnchors(e);
                return edgeGeom(a, b);
              };
              const stroke = () => edgeStroke(e);
              return (
                <>
                  <path
                    d={geom().d}
                    stroke={stroke()}
                    classList={{ selected: selectedEdge() === e.id }}
                    marker-end={e.toEnd === "none" ? undefined : `url(#${markerId(stroke())})`}
                    marker-start={e.fromEnd === "arrow" ? `url(#${markerId(stroke())})` : undefined}
                    onMouseDown={(ev) => {
                      ev.stopPropagation();
                      setSelectedCard(null);
                      setSelectedEdge(e.id);
                    }}
                  />
                  <Show when={e.label}>
                    <text class="edge-label" x={geom().mx} y={geom().my}>
                      {e.label}
                    </text>
                  </Show>
                </>
              );
            }}
          </For>
          {/* Hai đầu edge đang chọn: kéo để nối lại chỗ khác */}
          <Show when={selectedEdgeObj()} keyed>
            {(e) => {
              const pts = () => edgeAnchors(e);
              return (
                <>
                  <circle class="edge-handle" cx={pts()[0].x} cy={pts()[0].y} r={6} onMouseDown={(ev) => grabEdgeEnd(ev, e, "from")} />
                  <circle class="edge-handle" cx={pts()[1].x} cy={pts()[1].y} r={6} onMouseDown={(ev) => grabEdgeEnd(ev, e, "to")} />
                </>
              );
            }}
          </Show>
          <Show when={linking()}>
            {(l) => {
              const mouse = () => ({ x: l().x, y: l().y, dx: 0, dy: 0 });
              const fixed = () => anchor(l().fixedNode, l().fixedSide, mouse());
              return (
                <path
                  class="temp"
                  d={
                    l().movingEnd === "to"
                      ? edgeGeom(fixed(), mouse()).d
                      : edgeGeom(mouse(), fixed()).d
                  }
                />
              );
            }}
          </Show>
        </svg>
        {/* z-order theo thứ tự mảng nodes (spec): phần tử trước nằm dưới — group Obsidian đặt đầu mảng */}
        <For each={doc().nodes}>
          {(n) => {
            const tint = () => cardColor(n);
            if (n.type === "group") {
              return (
                <div
                  class="canvas-group"
                  data-node-id={n.id}
                  classList={{ selected: selectedCard() === n.id }}
                  style={{
                    left: `${n.x}px`,
                    top: `${n.y}px`,
                    width: `${n.width}px`,
                    height: `${n.height}px`,
                    ...(tint() ? { "border-color": tint()!, background: `${tint()}12` } : {}),
                  }}
                  onMouseDown={(e) => onCardDown(e, n)}
                >
                  <Show when={selectedCard() === n.id}>
                    <div class="card-toolbar" onMouseDown={(e) => e.stopPropagation()}>
                      <For each={Object.entries(PALETTE)}>
                        {([key, hex]) => (
                          <button
                            class="color-dot"
                            classList={{ active: n.color === key }}
                            style={{ background: hex }}
                            title={`Màu ${key}`}
                            onClick={() => setColor(n.id, key)}
                          />
                        )}
                      </For>
                      <button class="color-dot none" title="Bỏ màu" onClick={() => setColor(n.id, undefined)} />
                      <span class="card-toolbar-sep" />
                      <button class="card-toolbar-btn" title="Xóa group (Delete)" onClick={() => removeCard(n.id)}>
                        <IconTrash />
                      </button>
                    </div>
                  </Show>
                  <span class="canvas-group-label" style={tint() ? { color: tint()! } : {}}>
                    {n.label || "Group"}
                  </span>
                </div>
              );
            }
            return (
              <div
                class="canvas-card"
                classList={{
                  "canvas-file": n.type === "file",
                  selected: selectedCard() === n.id,
                }}
                data-node-id={n.id}
                style={{
                  left: `${n.x}px`,
                  top: `${n.y}px`,
                  width: `${n.width}px`,
                  height: `${n.height}px`,
                  ...(tint()
                    ? { "border-color": tint()!, background: `${tint()}1a` }
                    : {}),
                }}
                onMouseDown={(e) => onCardDown(e, n)}
                onDblClick={(e) => {
                  e.stopPropagation();
                  if (n.type === "text") setEditing(n.id);
                  else if (n.type === "file" && n.file && !isImagePath(n.file)) props.onOpenNote(n.file);
                  else if (n.type === "link" && n.url) window.open(n.url, "_blank");
                }}
              >
                {/* Toolbar nổi khi card được chọn: 6 màu + bỏ màu + xóa */}
                <Show when={selectedCard() === n.id && editing() !== n.id}>
                  <div class="card-toolbar" onMouseDown={(e) => e.stopPropagation()}>
                    <For each={Object.entries(PALETTE)}>
                      {([key, hex]) => (
                        <button
                          class="color-dot"
                          classList={{ active: n.color === key }}
                          style={{ background: hex }}
                          title={`Màu ${key}`}
                          onClick={() => setColor(n.id, key)}
                        />
                      )}
                    </For>
                    <button class="color-dot none" title="Bỏ màu" onClick={() => setColor(n.id, undefined)} />
                    <span class="card-toolbar-sep" />
                    <button class="card-toolbar-btn" title="Xóa card (Delete)" onClick={() => removeCard(n.id)}>
                      <IconTrash />
                    </button>
                  </div>
                </Show>
                <div class="canvas-port left" title="Kéo để nối" onMouseDown={(e) => startLink(e, n, "left")} />
                <div class="canvas-port right" title="Kéo để nối" onMouseDown={(e) => startLink(e, n, "right")} />
                <div class="canvas-port top" title="Kéo để nối" onMouseDown={(e) => startLink(e, n, "top")} />
                <div class="canvas-port bottom" title="Kéo để nối" onMouseDown={(e) => startLink(e, n, "bottom")} />
                {n.type === "file" && isImagePath(n.file) ? (
                  <CanvasImage path={n.file!} />
                ) : n.type === "file" ? (
                  <div class="canvas-file-body">
                    <div class="canvas-file-name">
                      📄 {n.file?.replace(/\.md$/i, "")}
                      {n.subpath ?? ""}
                    </div>
                    <div class="canvas-file-hint">double-click để mở</div>
                  </div>
                ) : n.type === "link" ? (
                  <div class="canvas-file-body">
                    <div class="canvas-file-name">🔗 {n.url}</div>
                    <div class="canvas-file-hint">double-click mở trong trình duyệt</div>
                  </div>
                ) : editing() === n.id ? (
                  <textarea
                    class="canvas-textarea"
                    value={n.text ?? ""}
                    autofocus
                    onBlur={(e) => {
                      mutate((d) => ({
                        ...d,
                        nodes: d.nodes.map((x) =>
                          x.id === n.id ? { ...x, text: e.currentTarget.value } : x,
                        ),
                      }));
                      setEditing(null);
                    }}
                  />
                ) : (
                  <div class="canvas-text">
                    <Show when={n.text} fallback={<>…</>}>
                      <LinkifiedText text={n.text!} onOpenNote={props.onOpenNote} />
                    </Show>
                  </div>
                )}
              </div>
            );
          }}
        </For>
      </div>
      <div class="canvas-toolbar">
        <button
          title="Thêm card text"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const rect = host.getBoundingClientRect();
            const w = toWorld(rect.left + host.clientWidth / 2, rect.top + host.clientHeight / 3);
            newTextCard(w.x, w.y);
          }}
        >
          <IconTextCard />
        </button>
        <button title="Thêm note từ vault" onMouseDown={(e) => e.stopPropagation()} onClick={addNoteCard}>
          <IconNoteCard />
        </button>
        <button title="Chèn ảnh (hoặc Ctrl+V dán ảnh)" onMouseDown={(e) => e.stopPropagation()} onClick={insertImage}>
          <IconImage />
        </button>
        <span class="canvas-hint">
          lăn chuột: pan (Shift = ngang) · Ctrl+lăn: zoom · Ctrl+V: dán ảnh · chọn edge rồi kéo 2 đầu để nối lại
        </span>
      </div>
    </div>
  );
}
