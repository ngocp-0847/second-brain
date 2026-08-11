// Kéo note/canvas từ sidebar bằng POINTER EVENT, không dùng HTML5 drag-and-drop.
//
// Vì sao không dùng dataTransfer: WebView2 trong app này không khởi động vòng
// drag của OS, nên `dragstart` không bao giờ bắn — cả kéo note vào folder lẫn
// kéo note vào canvas đều chết. Pointer event thì chỉ là chuột thuần, chạy ở
// mọi WebView và test được bằng input tổng hợp.
//
// Vùng nhận thả tự khai báo bằng data-attribute, module này tìm bằng
// elementFromPoint lúc con trỏ di chuyển:
//   data-drop-dir="<đường/dẫn/folder>"   ("" = gốc vault)
//   data-drop-canvas                      (thả để chèn card vào canvas)
import { createSignal, Show } from "solid-js";

/** Ngưỡng px phải vượt qua mới coi là kéo — dưới ngưỡng vẫn là click mở note. */
const THRESHOLD = 5;

export type DropTarget =
  | { kind: "dir"; dir: string }
  | { kind: "canvas"; x: number; y: number }
  | null;

interface Drag {
  path: string;
  /** Nhãn hiện trên "bóng" đi theo con trỏ. */
  label: string;
  x: number;
  y: number;
}

const [drag, setDrag] = createSignal<Drag | null>(null);
const [target, setTarget] = createSignal<DropTarget>(null);

/** Folder đang được rê qua — tree dùng để tô sáng. null = không có. */
export const dropDir = () => {
  const t = target();
  return t?.kind === "dir" ? t.dir : null;
};

export const dragging = () => drag() !== null;

// Chỗ nhận thả đăng ký ở đây; module không biết gì về tree hay canvas.
type DirDrop = (from: string, toDir: string) => void;
type CanvasDrop = (from: string, clientX: number, clientY: number) => void;
let onDirDrop: DirDrop | undefined;
let onCanvasDrop: CanvasDrop | undefined;

export function setDirDropHandler(h?: DirDrop) {
  onDirDrop = h;
}
export function setCanvasDropHandler(h?: CanvasDrop) {
  onCanvasDrop = h;
}

/** Vừa kéo xong → chặn cú click phát sinh sau pointerup, khỏi mở note ngoài ý. */
let dragged = false;
export const consumeDragClick = () => {
  const d = dragged;
  dragged = false;
  return d;
};

function resolve(x: number, y: number): DropTarget {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const dir = el.closest("[data-drop-dir]");
  if (dir) return { kind: "dir", dir: dir.getAttribute("data-drop-dir") ?? "" };
  if (el.closest("[data-drop-canvas]")) return { kind: "canvas", x, y };
  return null;
}

/** Gắn vào onPointerDown của một dòng file trong sidebar. */
export function beginDrag(e: PointerEvent, path: string, label: string) {
  // Chỉ chuột trái; chuột giữa/phải có ý nghĩa khác (mở tab mới / menu).
  if (e.button !== 0) return;
  // Đang đổi tên tại chỗ: bấm trong ô input là để đặt con trỏ / bôi đen chữ.
  if ((e.target as HTMLElement | null)?.closest("input, textarea")) return;
  // Cờ còn sót của lần kéo trước (bị hủy nên không có click để tiêu thụ) sẽ ăn
  // mất cú click này — xóa ngay từ pointerdown.
  dragged = false;
  const startX = e.clientX;
  const startY = e.clientY;
  let active = false;

  const move = (ev: PointerEvent) => {
    if (!active) {
      if (Math.abs(ev.clientX - startX) < THRESHOLD && Math.abs(ev.clientY - startY) < THRESHOLD) {
        return;
      }
      active = true;
      dragged = true;
      setDrag({ path, label, x: ev.clientX, y: ev.clientY });
    }
    setDrag((d) => (d ? { ...d, x: ev.clientX, y: ev.clientY } : d));
    setTarget(resolve(ev.clientX, ev.clientY));
  };

  // Drag native của WebView2 làm mất pointermove và bắn pointercancel → kéo chết
  // giữa đường, con trỏ hiện icon "cấm". CSS đã đặt -webkit-user-drag: none, đây
  // là chốt thứ hai cho mọi phần tử tự nhận drag (ảnh, link) nằm trong dòng file.
  const stopNativeDrag = (ev: Event) => ev.preventDefault();

  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("dragstart", stopNativeDrag);
    const t = target();
    const d = drag();
    setDrag(null);
    setTarget(null);
    if (!drop || !active || !d) return;
    if (t?.kind === "dir") onDirDrop?.(d.path, t.dir);
    else if (t?.kind === "canvas") onCanvasDrop?.(d.path, t.x, t.y);
  };

  const up = () => finish(true);
  // Bị hủy (WebView2 giành pointer, tab mất focus…) thì bỏ, đừng di chuyển file
  // vào chỗ con trỏ tình cờ đang nằm.
  const cancel = () => finish(false);

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("dragstart", stopNativeDrag);
}

/** "Bóng" đi theo con trỏ trong lúc kéo. Render một lần ở App. */
export function DragGhost() {
  return (
    <Show when={drag()}>
      {(d) => (
        <div class="drag-ghost" style={{ left: `${d().x + 12}px`, top: `${d().y + 12}px` }}>
          {d().label}
        </div>
      )}
    </Show>
  );
}
