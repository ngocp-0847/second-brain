// Context menu chuột phải dùng chung (sidebar tree, bookmark, canvas).
//
// Neo theo TỌA ĐỘ con trỏ chứ không theo phần tử, nên đo kích thước thật sau khi
// render rồi mới đặt vị trí — biết chắc menu không tràn ra ngoài cửa sổ. Việc
// đóng menu (click ra ngoài / Esc / cuộn / mất focus) gom hết vào đây để chỗ gọi
// chỉ cần dựng mảng item.
import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";

export interface MenuItem {
  label: string;
  icon?: Component<{ class?: string }>;
  onSelect?: () => void;
  /** Item cha của submenu: bỏ onSelect, đưa các item con vào đây. */
  submenu?: MenuItem[];
  /** Phím tắt hiện mờ bên phải, ví dụ "Ctrl+C". Chỉ để hiển thị. */
  shortcut?: string;
  /** Hành động phá huỷ (Xóa) — tô màu --danger. */
  danger?: boolean;
  /** Dòng kẻ ngăn nhóm; các field khác bỏ trống. */
  separator?: boolean;
}

export interface MenuAnchor {
  x: number;
  y: number;
  items: MenuItem[];
}

const MARGIN = 8;

/** Đẩy hộp w×h vào trong viewport: ưu tiên xuống-phải, tràn thì lật ngược lại. */
function fit(x: number, y: number, w: number, h: number) {
  const left = x + w + MARGIN > window.innerWidth ? Math.max(MARGIN, x - w) : x;
  const top = y + h + MARGIN > window.innerHeight ? Math.max(MARGIN, y - h) : y;
  return { left, top };
}

/** Một tầng menu. Submenu cũng là Panel nên lồng bao nhiêu tầng cũng được. */
function Panel(props: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  let el!: HTMLDivElement;
  // Đo xong mới hiện: một frame ở sai chỗ cũng đủ thấy nhấp nháy.
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  const [openSub, setOpenSub] = createSignal<{ index: number; x: number; y: number } | null>(null);

  onMount(() => {
    const r = el.getBoundingClientRect();
    setPos(fit(props.x, props.y, r.width, r.height));
  });

  return (
    <div
      class="ctx-menu"
      ref={el}
      style={{
        left: `${pos()?.left ?? props.x}px`,
        top: `${pos()?.top ?? props.y}px`,
        visibility: pos() ? "visible" : "hidden",
      }}
      // Menu nằm ngoài cây sidebar nên chuột phải trên chính nó sẽ rơi xuống
      // menu mặc định của WebView nếu không chặn.
      onContextMenu={(e) => e.preventDefault()}
    >
      <For each={props.items}>
        {(it, i) => (
          <Show
            when={!it.separator}
            fallback={<div class="ctx-sep" />}
          >
            <div
              class="ctx-item"
              classList={{ danger: it.danger, open: openSub()?.index === i() }}
              onMouseEnter={(e) => {
                if (!it.submenu) return setOpenSub(null);
                const r = e.currentTarget.getBoundingClientRect();
                setOpenSub({ index: i(), x: r.right - 4, y: r.top - 4 });
              }}
              onClick={() => {
                if (it.submenu) return;
                props.onClose();
                it.onSelect?.();
              }}
            >
              <Show when={it.icon} fallback={<span class="ctx-icon" />}>
                {(Icon) => <Dynamic component={Icon()} class="ctx-icon" />}
              </Show>
              <span class="ctx-label">{it.label}</span>
              <Show when={it.shortcut}>
                <span class="ctx-shortcut">{it.shortcut}</span>
              </Show>
              <Show when={it.submenu}>
                <span class="ctx-caret">›</span>
              </Show>
            </div>
          </Show>
        )}
      </For>

      <Show when={openSub()}>
        {(s) => (
          <Panel
            x={s().x}
            y={s().y}
            items={props.items[s().index].submenu!}
            onClose={props.onClose}
          />
        )}
      </Show>
    </div>
  );
}

export function ContextMenu(props: { anchor: MenuAnchor; onClose: () => void }) {
  onMount(() => {
    // pointerdown ở pha capture: đóng trước khi click kịp kích hoạt thứ gì bên
    // dưới. Click TRONG menu do Panel tự xử lý (stopPropagation không cần vì
    // handler này kiểm tra phần tử đích).
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement)?.closest(".ctx-menu")) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    const close = () => props.onClose();

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    // capture: cuộn trong sidebar không bubble lên window.
    document.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);

    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    });
  });

  return (
    <Panel
      x={props.anchor.x}
      y={props.anchor.y}
      items={props.anchor.items}
      onClose={props.onClose}
    />
  );
}
