// Canvas: bảng tự do tương thích định dạng JSON Canvas 1.0 (jsoncanvas.org) của Obsidian.
// - Đủ 4 loại node: text / file / link / group; z-order theo thứ tự mảng (spec)
// - Edge: fromSide/toSide 4 cạnh, fromEnd/toEnd, color, label; kéo lại 2 đầu khi chọn
// - Pan: kéo nền hoặc lăn chuột (shift = ngang) · zoom: Ctrl+lăn về phía con trỏ
// - Mở file là tự fit viewport vào nội dung; field lạ trong node được giữ nguyên khi lưu
// - `shape` trên node text là extension NGOÀI spec: Obsidian bỏ qua và hiện card chữ nhật
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, type NoteMeta } from "./api";
import { NOTE_DRAG_MIME } from "./dnd";
import { createEditor, type EditorHandle } from "./editor";
import {
  IconBold,
  IconBullets,
  IconCaret,
  IconCode,
  IconCursor,
  IconHeading,
  IconHelp,
  IconImage,
  IconItalic,
  IconLink,
  IconNoteCard,
  IconRedo,
  IconTextCard,
  IconTrash,
  IconUndo,
} from "./icons";
import { Markdown } from "./markdown";

export type ShapeKind =
  | "rect"
  | "rounded"
  | "ellipse"
  | "diamond"
  | "parallelogram"
  | "hexagon"
  | "sticky"
  | "triangle"
  | "star"
  | "cylinder"
  | "arrow";

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
  /** Ngoài spec JSON Canvas 1.0 — Obsidian bỏ qua, node hiện thành card chữ nhật. */
  shape?: ShapeKind;
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
type Box = { x: number; y: number; w: number; h: number };
type Tool = { kind: "select" } | { kind: "text" } | { kind: "shape"; shape: ShapeKind };

const uid = () => Math.random().toString(36).slice(2, 10);

/** Số bước undo giữ lại. */
const HISTORY_MAX = 100;

/** Kích thước card cho text dán vào: ước lượng số dòng sau khi wrap ở bề rộng
 *  cố định rồi kẹp lại, để đoạn dài không sinh ra card cao vô tận. */
const textCardSize = (text: string): [number, number] => {
  const w = 320;
  const perLine = 42; // ký tự/dòng ở 320px với font 14px
  const lines = text
    .split("\n")
    .reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  return [w, Math.min(420, Math.max(90, lines * 22 + 24))];
};

// Bảng màu preset chuẩn JSON Canvas ("1".."6"). Đây là màu DỮ LIỆU ghi vào file
// .canvas nên phải cố định để Obsidian đọc đúng — 6 tông pastel này đủ tương phản
// trên cả nền tối lẫn nền sáng nên không cần đổi theo theme.
const PALETTE: Record<string, string> = {
  "1": "#e0876a", // đỏ
  "2": "#e8a06a", // cam
  "3": "#e8c76a", // vàng
  "4": "#9ece8f", // lục
  "5": "#6ac4e0", // lam
  "6": "#a48fff", // tím
};

// Màu edge là màu GIAO DIỆN (không ghi vào file khi edge không có `color` riêng)
// nên đi qua token. Chuỗi "var(...)" chảy thẳng vào attribute stroke/fill của SVG,
// và markerId() lọc ký tự lạ nên vẫn sinh ra id hợp lệ.
const EDGE_DEFAULT = "var(--edge)";
const EDGE_SELECTED = "var(--accent)";

// ---- shape: vẽ trong hệ toạ độ world của node (viewBox = 0 0 w h) nên stroke không méo ----
const shapePath = (k: ShapeKind, w: number, h: number): string => {
  switch (k) {
    case "rect":
      return `M0 0 H${w} V${h} H0 Z`;
    case "rounded":
    case "sticky": {
      const r = Math.min(k === "sticky" ? 4 : 10, w / 2, h / 2);
      return (
        `M${r} 0 H${w - r} A${r} ${r} 0 0 1 ${w} ${r} V${h - r} ` +
        `A${r} ${r} 0 0 1 ${w - r} ${h} H${r} A${r} ${r} 0 0 1 0 ${h - r} ` +
        `V${r} A${r} ${r} 0 0 1 ${r} 0 Z`
      );
    }
    case "ellipse": {
      const rx = w / 2;
      const ry = h / 2;
      return `M0 ${ry} A${rx} ${ry} 0 1 0 ${w} ${ry} A${rx} ${ry} 0 1 0 0 ${ry} Z`;
    }
    case "diamond":
      return `M${w / 2} 0 L${w} ${h / 2} L${w / 2} ${h} L0 ${h / 2} Z`;
    case "parallelogram": {
      const k2 = Math.min(w * 0.2, h * 0.6);
      return `M${k2} 0 H${w} L${w - k2} ${h} H0 Z`;
    }
    case "hexagon": {
      const k2 = Math.min(w * 0.22, h / 2);
      return `M${k2} 0 H${w - k2} L${w} ${h / 2} L${w - k2} ${h} H${k2} L0 ${h / 2} Z`;
    }
    case "triangle":
      return `M${w / 2} 0 L${w} ${h} H0 Z`;
    case "star": {
      const cx = w / 2;
      const cy = h / 2;
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const f = i % 2 === 0 ? 1 : 0.42;
        pts.push(`${cx + Math.cos(a) * cx * f} ${cy + Math.sin(a) * cy * f}`);
      }
      return `M${pts.join(" L")} Z`;
    }
    case "cylinder": {
      const ry = Math.min(h * 0.18, w * 0.5);
      return (
        `M0 ${ry} A${w / 2} ${ry} 0 0 0 ${w} ${ry} V${h - ry} ` +
        `A${w / 2} ${ry} 0 0 1 0 ${h - ry} Z`
      );
    }
    case "arrow": {
      const hw = Math.min(w * 0.32, h * 0.9);
      return `M0 ${h * 0.26} H${w - hw} V0 L${w} ${h / 2} L${w - hw} ${h} V${h * 0.74} H0 Z`;
    }
  }
};

/** Nét phụ không tô (hiện chỉ có nắp trên của hình trụ). */
const shapeDetail = (k: ShapeKind, w: number, h: number): string | null => {
  if (k !== "cylinder") return null;
  const ry = Math.min(h * 0.18, w * 0.5);
  return `M0 ${ry} A${w / 2} ${ry} 0 0 1 ${w} ${ry}`;
};

const SHAPE_DEFAULT: Record<ShapeKind, [number, number]> = {
  rect: [200, 120],
  rounded: [200, 120],
  ellipse: [180, 120],
  diamond: [180, 130],
  parallelogram: [200, 110],
  hexagon: [200, 110],
  sticky: [200, 200],
  triangle: [180, 150],
  star: [160, 160],
  cylinder: [160, 150],
  arrow: [210, 100],
};

/** Padding nội dung để chữ không tràn ra ngoài viền shape. */
const SHAPE_INSET: Record<ShapeKind, string> = {
  rect: "10px 14px",
  rounded: "10px 14px",
  sticky: "14px 16px",
  ellipse: "14% 16%",
  diamond: "24% 22%",
  parallelogram: "12% 22%",
  hexagon: "12% 20%",
  triangle: "40% 16% 8%",
  star: "32% 27%",
  cylinder: "24% 14% 18%",
  arrow: "16% 32% 16% 10%",
};

/** Thứ tự hiện trong popover chọn shape (grid 4 cột). */
const SHAPES: { kind: ShapeKind; label: string }[] = [
  { kind: "rect", label: "Chữ nhật" },
  { kind: "rounded", label: "Chữ nhật bo tròn" },
  { kind: "ellipse", label: "Ellipse / tròn" },
  { kind: "diamond", label: "Hình thoi (quyết định)" },
  { kind: "parallelogram", label: "Bình hành (dữ liệu)" },
  { kind: "hexagon", label: "Lục giác" },
  { kind: "triangle", label: "Tam giác" },
  { kind: "star", label: "Ngôi sao" },
  { kind: "cylinder", label: "Trụ (database)" },
  { kind: "arrow", label: "Mũi tên khối" },
  { kind: "sticky", label: "Giấy nhớ" },
];


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
  loadImage(props.path)
    .then(setSrc)
    .catch(() => {});
  return (
    <Show when={src()} fallback={<div class="canvas-file-hint">đang tải ảnh…</div>}>
      <img class="canvas-img" src={src()!} draggable={false} alt={props.path} />
    </Show>
  );
}

const resolveColor = (c?: string) => (c ? (PALETTE[c] ?? (c.startsWith("#") ? c : null)) : null);
const cardColor = (n: CanvasNode) => resolveColor(n.color);

/** Lớp nền SVG của node có shape. Không dùng clip-path vì nó cắt mất card-toolbar + port. */
function ShapeLayer(props: { node: CanvasNode; tint: string | null }) {
  const kind = () => props.node.shape as ShapeKind;
  const sticky = () => kind() === "sticky";
  const fill = () =>
    sticky() ? (props.tint ?? PALETTE["3"]) : props.tint ? `${props.tint}1a` : "var(--bg-panel)";
  const stroke = () => (sticky() ? "transparent" : (props.tint ?? "var(--border-card)"));
  const d = () => shapePath(kind(), props.node.width, props.node.height);
  const detail = () => shapeDetail(kind(), props.node.width, props.node.height);
  return (
    <svg
      class="canvas-shape"
      viewBox={`0 0 ${props.node.width} ${props.node.height}`}
      preserveAspectRatio="none"
    >
      <path
        d={d()}
        fill={fill()}
        stroke={stroke()}
        stroke-width="1.5"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
      <Show when={detail()}>
        {(dd) => (
          <path
            d={dd()}
            fill="none"
            stroke={stroke()}
            stroke-width="1.5"
            vector-effect="non-scaling-stroke"
          />
        )}
      </Show>
    </svg>
  );
}

/** Icon shape trong toolbar — dùng lại chính shapePath() nên luôn khớp với hình thật. */
const ShapeGlyph = (props: { kind: ShapeKind }) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linejoin="round"
  >
    <path
      d={shapePath(props.kind, 16, 16)}
      transform="translate(2,2)"
      fill={props.kind === "sticky" ? "currentColor" : "none"}
      fill-opacity={props.kind === "sticky" ? "0.28" : "0"}
    />
    <Show when={shapeDetail(props.kind, 16, 16)}>
      {(d) => <path d={d()} transform="translate(2,2)" fill="none" />}
    </Show>
  </svg>
);

/** Editor đầy đủ cho card text (kể cả giấy nhớ): dùng chính CodeMirror của note
 *  editor nên có live-preview (đậm/nghiêng/heading hiện ngay khi gõ), autocomplete
 *  `[[wikilink]]`, và mọi phím tắt quen thuộc — thay cho textarea trơ trước đây.
 *
 *  Chỉ commit khi đóng, KHÔNG commit theo từng phím: `mutate` tạo object node mới
 *  nên `<For>` sẽ dựng lại DOM của card và giết luôn EditorView đang gõ dở. */
function CardEditor(props: {
  text: string;
  getNotes: () => NoteMeta[];
  onOpenNote: (path: string) => void;
  onDone: (text: string) => void;
}) {
  let host!: HTMLDivElement;
  let wrapper!: HTMLDivElement;
  let handle: EditorHandle | undefined;
  let committed = false;

  const commit = () => {
    if (committed || !handle) return;
    committed = true;
    props.onDone(handle.getContent());
  };

  onMount(() => {
    handle = createEditor({
      parent: host,
      getNotes: props.getNotes,
      // Autosave của CM không dùng ở đây — xem ghi chú về remount phía trên.
      onSave: () => {},
      onOpenLink: props.onOpenNote,
      dark: !document.documentElement.matches('[data-theme="light"]'),
    });
    handle.setContent(props.text);
    queueMicrotask(() => handle?.view.focus());
  });

  onCleanup(() => {
    commit();
    handle?.destroy();
  });

  /** Bọc vùng chọn (đậm/nghiêng/code). Không chọn gì thì chèn cặp dấu và đặt con trỏ vào giữa. */
  const wrap = (mark: string) => {
    const v = handle?.view;
    if (!v) return;
    const r = v.state.selection.main;
    const sel = v.state.sliceDoc(r.from, r.to);
    handle!.replaceRange(r.from, r.to, `${mark}${sel}${mark}`);
    if (!sel) {
      const pos = r.from + mark.length;
      v.dispatch({ selection: { anchor: pos } });
    }
    v.focus();
  };

  /** Đổi tiền tố của dòng hiện tại (heading / bullet). Bấm lại tiền tố cũ = bỏ. */
  const prefix = (mark: string) => {
    const v = handle?.view;
    if (!v) return;
    const line = v.state.doc.lineAt(v.state.selection.main.from);
    const bare = line.text.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s+)/, "");
    const next = line.text.trimStart().startsWith(mark) ? bare : `${mark}${bare}`;
    handle!.replaceRange(line.from, line.to, next);
    v.focus();
  };

  return (
    <div
      class="card-editor"
      ref={wrapper}
      onMouseDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation(); // phím tắt canvas (Delete, Esc…) không được cướp phím gõ
        if (e.key === "Escape") {
          e.preventDefault();
          commit();
        }
      }}
      // Bấm ra ngoài card = xong. Nút format nằm trong wrapper nên không tính.
      onFocusOut={(e) => {
        if (!wrapper.contains(e.relatedTarget as Node | null)) commit();
      }}
    >
      <div class="card-format" onMouseDown={(e) => e.preventDefault()}>
        <button title="Đậm (**text**)" onClick={() => wrap("**")}>
          <IconBold />
        </button>
        <button title="Nghiêng (*text*)" onClick={() => wrap("*")}>
          <IconItalic />
        </button>
        <button title="Code (`text`)" onClick={() => wrap("`")}>
          <IconCode />
        </button>
        <span class="card-format-sep" />
        <button title="Heading (## )" onClick={() => prefix("## ")}>
          <IconHeading />
        </button>
        <button title="Gạch đầu dòng (- )" onClick={() => prefix("- ")}>
          <IconBullets />
        </button>
      </div>
      <div class="card-editor-host" ref={host} />
    </div>
  );
}

export function CanvasView(props: {
  path: string;
  getNotes: () => NoteMeta[];
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
  // Tool đang chọn: "select" = pan/kéo như cũ; còn lại là chế độ đặt node (click hoặc kéo trên nền).
  const [tool, setTool] = createSignal<Tool>({ kind: "select" });
  const [lastShape, setLastShape] = createSignal<ShapeKind>("rect");
  const [shapeMenu, setShapeMenu] = createSignal(false);
  // Node đang mở bảng đổi shape trên card-toolbar (null = không mở).
  const [shapePick, setShapePick] = createSignal<string | null>(null);
  const [helpOpen, setHelpOpen] = createSignal(false);
  // Khung nét đứt xem trước khi kéo vẽ kích thước.
  const [draft, setDraft] = createSignal<Box | null>(null);
  let placeStart: { x: number; y: number } | null = null;
  // Lịch sử undo/redo: chồng ảnh chụp CanvasDoc (doc bất biến nên chụp = giữ tham chiếu).
  const [past, setPast] = createSignal<CanvasDoc[]>([]);
  const [future, setFuture] = createSignal<CanvasDoc[]>([]);
  let gestureKey: string | null = null;
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

  /** Ghi lịch sử rồi đổi doc.
   *  `key` gom cả một thao tác liên tục (kéo card, resize) thành MỘT bước undo:
   *  các lần mutate cùng key liên tiếp chỉ chụp ảnh trạng thái ở lần đầu.
   *  Kết thúc thao tác (mouseup) gọi endGesture() để mở lại. */
  const mutate = (f: (d: CanvasDoc) => CanvasDoc, key?: string) => {
    if (!key || key !== gestureKey) {
      setPast((p) => [...p.slice(-(HISTORY_MAX - 1)), doc()]);
      setFuture([]);
      gestureKey = key ?? null;
    }
    setDoc(f(doc()));
    scheduleSave();
  };
  const endGesture = () => {
    gestureKey = null;
  };

  /** Undo/redo đổi cả mảng nodes nên bỏ luôn selection để không trỏ vào node đã biến mất. */
  const clearTransient = () => {
    setEditing(null);
    setSelectedCard(null);
    setSelectedEdge(null);
    setShapePick(null);
  };
  const undo = () => {
    const p = past();
    if (!p.length) return;
    endGesture();
    setFuture((f) => [...f, doc()]);
    setPast(p.slice(0, -1));
    setDoc(p[p.length - 1]);
    clearTransient();
    scheduleSave();
  };
  const redo = () => {
    const f = future();
    if (!f.length) return;
    endGesture();
    setPast((p) => [...p.slice(-(HISTORY_MAX - 1)), doc()]);
    setFuture(f.slice(0, -1));
    setDoc(f[f.length - 1]);
    clearTransient();
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

  /** Con trỏ đang nằm trong một vùng soạn thảo → phím và paste không thuộc về
   *  canvas. Phải xét cả `isContentEditable`: vùng gõ của CodeMirror là
   *  div[contenteditable], không phải textarea, nên chỉ check instanceof là lọt. */
  const inTextField = () => {
    const ae = document.activeElement as HTMLElement | null;
    return (
      !!ae &&
      (ae.isContentEditable || ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement)
    );
  };

  /** Listener nằm trên `window` nên vẫn nhận event kể cả khi canvas đã rời DOM.
   *  Chốt chặn độc lập với mọi guard khác. */
  const isLive = () => !!host?.isConnected;

  const onKey = (e: KeyboardEvent) => {
    if (!isLive() || inTextField()) return;
    // Ctrl/Cmd+Z undo · Ctrl+Shift+Z hoặc Ctrl+Y redo.
    if ((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key)) {
      if (editing()) return;
      e.preventDefault();
      if (e.key.toLowerCase() === "y" || e.shiftKey) redo();
      else undo();
      return;
    }
    if (e.key === "Escape") {
      setLinking(null);
      cancelPlacing();
      setShapeMenu(false);
      setHelpOpen(false);
      setShapePick(null);
      return;
    }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (editing()) return;
    if (selectedEdge()) {
      mutate((d) => ({
        ...d,
        edges: d.edges.filter((x) => x.id !== selectedEdge()),
      }));
      setSelectedEdge(null);
    } else if (selectedCard()) {
      removeCard(selectedCard()!);
      setSelectedCard(null);
    }
  };

  /** Ctrl+V: có file ảnh thì lưu vào assets/ rồi thêm card ảnh; không thì dán
   *  text thành card, giống Obsidian. */
  const onPaste = async (e: ClipboardEvent) => {
    if (!isLive() || inTextField() || editing()) return;
    const files = e.clipboardData?.files;
    if (!files?.length) {
      const text = e.clipboardData?.getData("text/plain")?.replace(/\r\n/g, "\n").trim();
      if (!text) return;
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      const c = toWorld(rect.left + host.clientWidth / 2, rect.top + host.clientHeight / 2);
      const [w, h] = textCardSize(text);
      createNode(null, { x: c.x - w / 2, y: c.y - h / 2, w, h }, text);
      return;
    }
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      e.preventDefault();
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) {
          bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        }
        const ext = (f.type.split("/")[1] ?? "png")
          .replace("jpeg", "jpg")
          .replace("svg+xml", "svg");
        const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const name =
          f.name && !/^image\.\w+$/i.test(f.name) ? f.name : `Pasted image ${stamp}.${ext}`;
        await addImageNode(await api.saveAsset(name, btoa(bin)));
      } catch (err) {
        console.error("paste ảnh thất bại:", err);
      }
    }
  };

  onMount(() => {
    // Đăng ký ĐỒNG BỘ. Nếu đặt sau `await` thì Solid đã mất Owner, onCleanup
    // không bao giờ được ghi nhận và listener sống mãi trên window — chính là
    // nguyên nhân dán vào note lại bị tạo card trong canvas đã đóng.
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
      if (saveTimer) clearTimeout(saveTimer); // đừng ghi đè file sau khi đã rời view
    });

    void (async () => {
      try {
        const raw = await api.readNote(props.path);
        const parsed = JSON.parse(raw);
        setDoc({ nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] });
      } catch {
        setDoc({ nodes: [], edges: [] });
      }
      fitView();
    })();
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
    !(
      t instanceof Element &&
      t.closest(".canvas-card, .canvas-group, .card-toolbar, .canvas-toolbar")
    );

  const cancelPlacing = () => {
    placeStart = null;
    setDraft(null);
    setTool({ kind: "select" });
  };
  const isShapeTool = (k: ShapeKind) => {
    const t = tool();
    return t.kind === "shape" && t.shape === k;
  };

  const onBgDown = (e: MouseEvent) => {
    if (!isBackground(e.target)) return;
    setShapeMenu(false);
    setHelpOpen(false);
    setShapePick(null);
    setSelectedEdge(null);
    setSelectedCard(null);
    if (tool().kind !== "select") {
      // Đang ở chế độ đặt: click = kích thước mặc định, kéo = vẽ theo bbox. Không pan.
      const w = toWorld(e.clientX, e.clientY);
      placeStart = { x: w.x, y: w.y };
      setDraft({ x: w.x, y: w.y, w: 0, h: 0 });
      return;
    }
    panning = true;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onMove = (e: MouseEvent) => {
    if (resizing) {
      const w = toWorld(e.clientX, e.clientY);
      applyResize(w.x, w.y);
      return;
    }
    if (placeStart) {
      const w = toWorld(e.clientX, e.clientY);
      setDraft({
        x: Math.min(placeStart.x, w.x),
        y: Math.min(placeStart.y, w.y),
        w: Math.abs(w.x - placeStart.x),
        h: Math.abs(w.y - placeStart.y),
      });
      return;
    }
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
      mutate(
        (d) => ({
          ...d,
          nodes: d.nodes.map((n) => {
            const g = byId.get(n.id);
            return g ? { ...n, x: Math.round(w.x - g.dx), y: Math.round(w.y - g.dy) } : n;
          }),
        }),
        "drag",
      );
    }
  };
  const onUp = (e: MouseEvent) => {
    endGesture();
    if (resizing) {
      resizing = null;
      return;
    }
    if (placeStart) {
      const t = tool();
      const kind = t.kind === "shape" ? t.shape : null;
      const [dw, dh] = kind ? SHAPE_DEFAULT[kind] : [260, 90];
      const d = draft();
      // Kéo dưới 12px world coi như click đơn → dùng kích thước mặc định, tâm tại điểm bấm.
      const box =
        d && d.w >= 12 && d.h >= 12
          ? d
          : {
              x: placeStart.x - dw / 2,
              y: placeStart.y - dh / 2,
              w: dw,
              h: dh,
            };
      cancelPlacing();
      createNode(kind, box);
      return;
    }
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
              {
                id: uid(),
                fromNode: l.fixedNode,
                toNode: toId,
                fromSide: l.fixedSide,
                toSide: side,
              },
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
  /** Tạo node text (kind = null) hoặc node có shape, rồi vào chế độ gõ chữ ngay. */
  const createNode = (kind: ShapeKind | null, b: Box, text = "") => {
    const id = uid();
    const node: CanvasNode = {
      id,
      type: "text",
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.w),
      height: Math.round(b.h),
      text,
      ...(kind ? { shape: kind } : {}),
      ...(kind === "sticky" ? { color: "3" } : {}), // giấy nhớ mặc định màu vàng
    };
    mutate((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setSelectedCard(id);
    // Card rỗng thì vào gõ ngay; card dán sẵn nội dung thì chỉ chọn, khỏi che chữ.
    if (!text) setEditing(id);
  };
  const newTextCard = (wx: number, wy: number) =>
    createNode(null, { x: wx - 130, y: wy - 45, w: 260, h: 90 });
  const onDblClick = (e: MouseEvent) => {
    if (!isBackground(e.target)) return;
    if (tool().kind !== "select") return;
    const w = toWorld(e.clientX, e.clientY);
    newTextCard(w.x, w.y);
  };

  // ---- kéo card (group kéo theo mọi node nằm trọn bên trong, giống Obsidian) ----
  let dragging: { id: string; dx: number; dy: number }[] | null = null;
  const onCardDown = (e: MouseEvent, n: CanvasNode) => {
    if (editing() === n.id) return;
    e.stopPropagation();
    if (selectedCard() !== n.id) setShapePick(null);
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
    setLinking({
      fixedNode: n.id,
      fixedSide: side,
      movingEnd: "to",
      x: w.x,
      y: w.y,
    });
  };

  /** Nhấc một đầu của edge đang chọn để nối lại chỗ khác. */
  const grabEdgeEnd = (e: MouseEvent, edge: CanvasEdge, end: "from" | "to") => {
    e.stopPropagation();
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    setLinking(
      end === "to"
        ? {
            fixedNode: edge.fromNode,
            fixedSide: edge.fromSide,
            movingEnd: "to",
            edgeId: edge.id,
            x: w.x,
            y: w.y,
          }
        : {
            fixedNode: edge.toNode,
            fixedSide: edge.toSide,
            movingEnd: "from",
            edgeId: edge.id,
            x: w.x,
            y: w.y,
          },
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
        {
          id,
          type: "file",
          x: Math.round(c.x - w / 2),
          y: Math.round(c.y - h / 2),
          width: w,
          height: h,
          file: rel,
        },
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

  /** Card trỏ tới note trong vault, tâm đặt tại (wx, wy) trong toạ độ world. */
  const addNoteNode = (path: string, wx: number, wy: number) => {
    const id = uid();
    mutate((d) => ({
      ...d,
      nodes: [
        ...d.nodes,
        {
          id,
          type: "file",
          x: Math.round(wx) - 150,
          y: Math.round(wy) - 70,
          width: 300,
          height: 140,
          file: path,
        },
      ],
    }));
    setSelectedCard(id);
  };

  const addNoteCard = () =>
    props.requestNotePick((path) => {
      const rect = host.getBoundingClientRect();
      const w = toWorld(rect.left + host.clientWidth / 2, rect.top + host.clientHeight / 2);
      addNoteNode(path, w.x, w.y);
    });

  // ---- kéo note từ sidebar thả vào canvas ----
  const [dropping, setDropping] = createSignal(false);
  const notePathFrom = (e: DragEvent) =>
    e.dataTransfer?.types.includes(NOTE_DRAG_MIME) ? e.dataTransfer.getData(NOTE_DRAG_MIME) : null;

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes(NOTE_DRAG_MIME)) return;
    // preventDefault ở dragover mới là thứ cho phép thả — thiếu nó trình duyệt
    // sẽ từ chối drop và không bao giờ bắn sự kiện onDrop.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };
  const onDragLeave = (e: DragEvent) => {
    // dragleave bắn cả khi con trỏ đi qua node con → chỉ tắt khi rời hẳn host.
    if (e.relatedTarget instanceof Node && host.contains(e.relatedTarget)) return;
    setDropping(false);
  };
  const onDrop = (e: DragEvent) => {
    const path = notePathFrom(e);
    setDropping(false);
    if (!path) return;
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    addNoteNode(path, w.x, w.y);
  };

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

  /** Đổi shape của node text đã vẽ; `undefined` = trả về card chữ nhật thường. */
  const setShape = (id: string, shape: ShapeKind | undefined) =>
    mutate((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        if (n.id !== id) return n;
        const { shape: _drop, ...rest } = n;
        return shape ? { ...rest, shape } : rest;
      }),
    }));

  // ---- resize: 8 tay nắm quanh node đang chọn ----
  const MIN_SIZE = 40;
  let resizing: { id: string; dir: string; start: CanvasNode } | null = null;
  const startResize = (e: MouseEvent, n: CanvasNode, dir: string) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedEdge(null);
    setSelectedCard(n.id);
    resizing = { id: n.id, dir, start: { ...n } };
  };
  const applyResize = (wx: number, wy: number) => {
    const r = resizing!;
    const s = r.start;
    let { x, y, width, height } = s;
    if (r.dir.includes("w")) {
      const right = s.x + s.width;
      x = Math.min(wx, right - MIN_SIZE);
      width = right - x;
    }
    if (r.dir.includes("e")) width = Math.max(MIN_SIZE, wx - s.x);
    if (r.dir.includes("n")) {
      const bottom = s.y + s.height;
      y = Math.min(wy, bottom - MIN_SIZE);
      height = bottom - y;
    }
    if (r.dir.includes("s")) height = Math.max(MIN_SIZE, wy - s.y);
    mutate(
      (d) => ({
        ...d,
        nodes: d.nodes.map((n) =>
          n.id === r.id
            ? {
                ...n,
                x: Math.round(x),
                y: Math.round(y),
                width: Math.round(width),
                height: Math.round(height),
              }
            : n,
        ),
      }),
      "resize",
    );
  };

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
    selectedEdge() === e.id ? EDGE_SELECTED : (resolveColor(e.color) ?? EDGE_DEFAULT);

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
      classList={{ placing: tool().kind !== "select", dropping: dropping() }}
      onMouseDown={onBgDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onWheel={onWheel}
      onDblClick={onDblClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        class="canvas-plane"
        style={{
          transform: `translate(${ox()}px, ${oy()}px) scale(${scale()})`,
        }}
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
                  <circle
                    class="edge-handle"
                    cx={pts()[0].x}
                    cy={pts()[0].y}
                    r={6}
                    onMouseDown={(ev) => grabEdgeEnd(ev, e, "from")}
                  />
                  <circle
                    class="edge-handle"
                    cx={pts()[1].x}
                    cy={pts()[1].y}
                    r={6}
                    onMouseDown={(ev) => grabEdgeEnd(ev, e, "to")}
                  />
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
                      <button
                        class="color-dot none"
                        title="Bỏ màu"
                        onClick={() => setColor(n.id, undefined)}
                      />
                      <span class="card-toolbar-sep" />
                      <button
                        class="card-toolbar-btn"
                        title="Xóa group (Delete)"
                        onClick={() => removeCard(n.id)}
                      >
                        <IconTrash />
                      </button>
                    </div>
                  </Show>
                  <Show when={selectedCard() === n.id}>
                    <For each={["nw", "ne", "se", "sw"]}>
                      {(dir) => (
                        <div
                          class={`canvas-resize ${dir}`}
                          title="Kéo để đổi kích thước"
                          onMouseDown={(e) => startResize(e, n, dir)}
                        />
                      )}
                    </For>
                  </Show>
                  <span class="canvas-group-label" style={tint() ? { color: tint()! } : {}}>
                    {n.label || "Group"}
                  </span>
                </div>
              );
            }
            // Node text có `shape` → nền là lớp SVG, card chỉ còn vai trò hit-box.
            const shaped = () => n.type === "text" && !!n.shape;
            // Chỉ 4 góc: 4 điểm giữa cạnh đã bị .canvas-port chiếm chỗ.
            const Handles = () => (
              <For each={["nw", "ne", "se", "sw"]}>
                {(dir) => (
                  <div
                    class={`canvas-resize ${dir}`}
                    title="Kéo để đổi kích thước"
                    onMouseDown={(e) => startResize(e, n, dir)}
                  />
                )}
              </For>
            );
            const ShapePicker = () => (
              <div class="ct-group">
                <button
                  class="card-toolbar-btn card-shape-btn"
                  classList={{ open: shapePick() === n.id }}
                  title="Đổi hình khối"
                  onClick={() => setShapePick(shapePick() === n.id ? null : n.id)}
                >
                  <ShapeGlyph kind={n.shape ?? "rounded"} />
                </button>
                <Show when={shapePick() === n.id}>
                  <div class="ct-popover ct-shape-grid">
                    <button
                      class="ct-shape-item"
                      classList={{ active: !n.shape }}
                      title="Card thường (bỏ hình khối)"
                      onClick={() => {
                        setShape(n.id, undefined);
                        setShapePick(null);
                      }}
                    >
                      <IconTextCard />
                    </button>
                    <For each={SHAPES}>
                      {(s) => (
                        <button
                          class="ct-shape-item"
                          classList={{ active: n.shape === s.kind }}
                          title={s.label}
                          onClick={() => {
                            setShape(n.id, s.kind);
                            setShapePick(null);
                          }}
                        >
                          <ShapeGlyph kind={s.kind} />
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            );
            const Content = () => (
              <>
                {n.type === "file" && isImagePath(n.file) ? (
                  <CanvasImage path={n.file!} />
                ) : n.type === "file" ? (
                  <div class="canvas-file-body">
                    <div class="canvas-file-name">
                      <IconNoteCard /> {n.file?.replace(/\.md$/i, "")}
                      {n.subpath ?? ""}
                    </div>
                    <div class="canvas-file-hint">double-click để mở</div>
                  </div>
                ) : n.type === "link" ? (
                  <div class="canvas-file-body">
                    <div class="canvas-file-name">
                      <IconLink /> {n.url}
                    </div>
                    <div class="canvas-file-hint">double-click mở trong trình duyệt</div>
                  </div>
                ) : editing() === n.id ? (
                  <CardEditor
                    text={n.text ?? ""}
                    getNotes={props.getNotes}
                    onOpenNote={props.onOpenNote}
                    onDone={(text) => {
                      if (text !== (n.text ?? "")) {
                        mutate((d) => ({
                          ...d,
                          nodes: d.nodes.map((x) => (x.id === n.id ? { ...x, text } : x)),
                        }));
                      }
                      setEditing(null);
                    }}
                  />
                ) : (
                  <div class="canvas-text">
                    <Show when={n.text} fallback={<>…</>}>
                      <Markdown text={n.text!} onOpenNote={props.onOpenNote} />
                    </Show>
                  </div>
                )}
              </>
            );
            return (
              <div
                class="canvas-card"
                classList={{
                  "canvas-file": n.type === "file",
                  "canvas-shaped": shaped(),
                  "canvas-sticky": n.shape === "sticky",
                  selected: selectedCard() === n.id,
                }}
                data-node-id={n.id}
                style={{
                  left: `${n.x}px`,
                  top: `${n.y}px`,
                  width: `${n.width}px`,
                  height: `${n.height}px`,
                  // Node có shape: màu nằm trong SVG, không tô lên card.
                  ...(tint() && !shaped()
                    ? { "border-color": tint()!, background: `${tint()}1a` }
                    : {}),
                }}
                onMouseDown={(e) => onCardDown(e, n)}
                onDblClick={(e) => {
                  e.stopPropagation();
                  if (n.type === "text") setEditing(n.id);
                  else if (n.type === "file" && n.file && !isImagePath(n.file))
                    props.onOpenNote(n.file);
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
                    <button
                      class="color-dot none"
                      title="Bỏ màu"
                      onClick={() => setColor(n.id, undefined)}
                    />
                    <Show when={n.type === "text"}>
                      <span class="card-toolbar-sep" />
                      <ShapePicker />
                    </Show>
                    <span class="card-toolbar-sep" />
                    <button
                      class="card-toolbar-btn"
                      title="Xóa card (Delete)"
                      onClick={() => removeCard(n.id)}
                    >
                      <IconTrash />
                    </button>
                  </div>
                </Show>
                <Show when={selectedCard() === n.id && editing() !== n.id}>
                  <Handles />
                </Show>
                <div
                  class="canvas-port left"
                  title="Kéo để nối"
                  onMouseDown={(e) => startLink(e, n, "left")}
                />
                <div
                  class="canvas-port right"
                  title="Kéo để nối"
                  onMouseDown={(e) => startLink(e, n, "right")}
                />
                <div
                  class="canvas-port top"
                  title="Kéo để nối"
                  onMouseDown={(e) => startLink(e, n, "top")}
                />
                <div
                  class="canvas-port bottom"
                  title="Kéo để nối"
                  onMouseDown={(e) => startLink(e, n, "bottom")}
                />
                <Show
                  when={shaped()}
                  fallback={
                    <div class="canvas-card-body">
                      <Content />
                    </div>
                  }
                >
                  <ShapeLayer node={n} tint={tint()} />
                  <div class="canvas-shape-body" style={{ padding: SHAPE_INSET[n.shape!] }}>
                    <Content />
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
        {/* Preview khi kéo: vẽ đúng hình của tool đang chọn, co giãn theo chuột */}
        <Show when={draft()}>
          {(d) => {
            const t = tool();
            const kind = t.kind === "shape" ? t.shape : "rounded";
            const w = () => Math.max(d().w, 1);
            const h = () => Math.max(d().h, 1);
            return (
              <svg
                class="canvas-draft"
                style={{
                  left: `${d().x}px`,
                  top: `${d().y}px`,
                  width: `${w()}px`,
                  height: `${h()}px`,
                }}
                viewBox={`0 0 ${w()} ${h()}`}
                preserveAspectRatio="none"
              >
                <path d={shapePath(kind, w(), h())} vector-effect="non-scaling-stroke" />
                <Show when={shapeDetail(kind, w(), h())}>
                  {(dd) => <path d={dd()} class="detail" vector-effect="non-scaling-stroke" />}
                </Show>
              </svg>
            );
          }}
        </Show>
      </div>
      <div class="canvas-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        <button
          class="ct-btn"
          title="Hoàn tác (Ctrl+Z)"
          disabled={past().length === 0}
          onClick={undo}
        >
          <IconUndo />
        </button>
        <button
          class="ct-btn"
          title="Làm lại (Ctrl+Shift+Z)"
          disabled={future().length === 0}
          onClick={redo}
        >
          <IconRedo />
        </button>
        <span class="ct-sep" />
        <button
          class="ct-btn"
          classList={{ active: tool().kind === "select" }}
          title="Chọn / di chuyển (Esc)"
          onClick={() => cancelPlacing()}
        >
          <IconCursor />
        </button>
        <span class="ct-sep" />
        <button
          class="ct-btn"
          classList={{ active: tool().kind === "text" }}
          title="Card text — click hoặc kéo trên canvas để đặt. Đổi sang giấy nhớ hoặc hình khối bằng bảng shape trên card."
          onClick={() => {
            setShapeMenu(false);
            setTool({ kind: "text" });
          }}
        >
          <IconTextCard />
        </button>
        <div class="ct-group">
          <button
            class="ct-btn ct-btn-split"
            classList={{ active: tool().kind === "shape" }}
            title="Hình khối & giấy nhớ — chọn loại rồi click/kéo trên canvas"
            onClick={() => {
              setTool({ kind: "shape", shape: lastShape() });
              setShapeMenu(!shapeMenu());
            }}
          >
            <ShapeGlyph kind={lastShape()} />
            <IconCaret />
          </button>
          <Show when={shapeMenu()}>
            <div class="ct-popover ct-shape-grid">
              <For each={SHAPES}>
                {(s) => (
                  <button
                    class="ct-shape-item"
                    classList={{ active: isShapeTool(s.kind) }}
                    title={s.label}
                    onClick={() => {
                      setLastShape(s.kind);
                      setTool({ kind: "shape", shape: s.kind });
                      setShapeMenu(false);
                    }}
                  >
                    <ShapeGlyph kind={s.kind} />
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <span class="ct-sep" />
        <button class="ct-btn" title="Thêm note từ vault" onClick={addNoteCard}>
          <IconNoteCard />
        </button>
        <button class="ct-btn" title="Chèn ảnh (hoặc Ctrl+V để dán)" onClick={insertImage}>
          <IconImage />
        </button>
        <span class="ct-sep" />
        <div class="ct-group">
          <button
            class="ct-btn"
            classList={{ active: helpOpen() }}
            title="Thao tác & phím tắt"
            onClick={() => setHelpOpen(!helpOpen())}
          >
            <IconHelp />
          </button>
          <Show when={helpOpen()}>
            <div class="ct-popover ct-help">
              <div>
                <b>Lăn chuột</b> pan · <b>Shift+lăn</b> pan ngang · <b>Ctrl+lăn</b> zoom
              </div>
              <div>
                Chọn tool rồi <b>click</b> để đặt, <b>kéo</b> để vẽ kích thước
              </div>
              <div>
                <b>Double-click nền</b> tạo card text · <b>Ctrl+V</b> dán ảnh
              </div>
              <div>Kéo từ chấm tròn mép card để nối · chọn edge rồi kéo 2 đầu để nối lại</div>
              <div>Chọn node rồi kéo ô vuông ở 4 góc để đổi kích thước</div>
              <div>
                <b>Delete</b> xoá card/edge đang chọn · <b>Esc</b> huỷ tool
              </div>
              <div>
                <b>Ctrl+Z</b> hoàn tác · <b>Ctrl+Shift+Z</b> làm lại
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
