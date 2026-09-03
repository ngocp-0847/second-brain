import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { api } from "./api";
import {
  IconClear,
  IconClose,
  IconMaximize,
  IconMinimize,
  IconRestart,
  IconTerminal,
} from "./icons";
import { cssVar, isDark } from "./theme";

/** Bảng 16 màu ANSI. xterm vẽ bằng canvas/WebGL nên không hiểu var(), và đây là
 *  chuẩn terminal chứ không phải token của app — giữ literal là đúng chỗ.
 *  Không khai báo thì xterm dùng bảng mặc định vốn tuned cho nền tối: ở light
 *  theme brightWhite/brightYellow sẽ chìm hẳn. */
const ANSI_DARK = {
  black: "#14161d",
  red: "#e0876a",
  green: "#9ece8f",
  yellow: "#e8c76a",
  blue: "#8fa8ff",
  magenta: "#a48fff",
  cyan: "#6ac4e0",
  white: "#c7cddd",
  brightBlack: "#67708a",
  brightRed: "#eda58c",
  brightGreen: "#b6dcaa",
  brightYellow: "#f0d98f",
  brightBlue: "#adbeff",
  brightMagenta: "#c9b8ff",
  brightCyan: "#92d8ec",
  brightWhite: "#e8eaf2",
};

const ANSI_LIGHT = {
  black: "#383d4e",
  red: "#c0492a",
  green: "#3f8f4f",
  yellow: "#9a7212",
  blue: "#3b5bdb",
  magenta: "#6d4fe0",
  cyan: "#147a94",
  white: "#6b7285",
  brightBlack: "#8b93a7",
  brightRed: "#a13a1f",
  brightGreen: "#2f7a3e",
  brightYellow: "#7d5c0c",
  brightBlue: "#2947b8",
  brightMagenta: "#5a35d6",
  brightCyan: "#0f6178",
  brightWhite: "#1b1e28",
};

const termTheme = () => ({
  background: cssVar("--bg-ribbon"),
  foreground: cssVar("--fg"),
  cursor: cssVar("--accent"),
  selectionBackground: cssVar("--accent-bg-hover"),
  ...(isDark() ? ANSI_DARK : ANSI_LIGHT),
});

/** Chiều cao panel: nhớ qua localStorage như VS Code nhớ kích thước panel. */
const HEIGHT_KEY = "term.height";
const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 300;
/** Dòng scrollback giữ lại — đủ cho một phiên claude dài mà vẫn nhẹ RAM. */
const SCROLLBACK = 10_000;

const loadHeight = () => {
  const n = Number(localStorage.getItem(HEIGHT_KEY));
  return Number.isFinite(n) && n >= MIN_HEIGHT ? n : DEFAULT_HEIGHT;
};

/** Panel terminal dưới cùng, hành xử như panel Terminal của VS Code: kéo viền trên để
 *  đổi chiều cao (nhớ lại lần sau), nút maximize, scrollback dài có thanh cuộn, và
 *  luôn fit lại cols×rows → báo PTY khi panel hoặc cửa sổ đổi kích thước.
 *  Bên dưới là PTY thật (ConPTY) chạy PowerShell trong vault và tự gõ `claude`.
 *  Ẩn/hiện không giết phiên. */
export function TermPanel(props: { visible: boolean; onClose: () => void }) {
  let panel!: HTMLDivElement;
  let host!: HTMLDivElement;
  let term: Terminal | undefined;
  const fit = new FitAddon();
  let ptyId: number | null = null;
  const [exited, setExited] = createSignal(false);
  const [height, setHeight] = createSignal(loadHeight());
  const [maxed, setMaxed] = createSignal(false);
  const [resizing, setResizing] = createSignal(false);
  // Chiều cao vùng chứa (main) — cập nhật qua ResizeObserver để maximize bám theo cửa sổ.
  const [parentH, setParentH] = createSignal(0);

  /** Trần chiều cao: toàn bộ main trừ tabbar, để tab vẫn bấm được khi maximize. */
  const maxHeight = () => {
    const parent = panel?.parentElement;
    const tab = parent?.querySelector<HTMLElement>(".tabbar");
    const cap = (parentH() || parent?.clientHeight || 0) - (tab?.offsetHeight ?? 0);
    return Math.max(MIN_HEIGHT, cap);
  };
  const clampH = (h: number) => Math.max(MIN_HEIGHT, Math.min(h, maxHeight()));
  const panelHeight = () => (maxed() ? maxHeight() : clampH(height()));

  const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  // Gộp nhiều nhịp resize liên tiếp (kéo thanh, kéo cửa sổ) thành một lần báo PTY —
  // ConPTY vẽ lại toàn màn hình mỗi lần resize nên báo dồn sẽ giật.
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const syncPty = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (ptyId != null && term) api.termResize(ptyId, term.cols, term.rows).catch(() => {});
    }, 40);
  };

  /** Đo lại host → cols×rows; chỉ báo PTY khi kích thước thật sự đổi. */
  const refit = () => {
    if (!props.visible || !term || host.clientWidth === 0 || host.clientHeight === 0) return;
    const before = `${term.cols}x${term.rows}`;
    fit.fit();
    if (`${term.cols}x${term.rows}` !== before) syncPty();
  };

  const spawn = async () => {
    if (!term) return;
    fit.fit();
    try {
      ptyId = await api.termOpen(term.cols, term.rows);
      setExited(false);
    } catch (e) {
      term.writeln(`\x1b[31m${String(e)}\x1b[0m`);
    }
  };

  const restart = async () => {
    if (ptyId != null) await api.termKill(ptyId).catch(() => {});
    ptyId = null;
    term?.reset();
    await spawn();
    term?.focus();
  };

  const clear = () => {
    term?.clear();
    term?.focus();
  };

  const ensure = async () => {
    if (term) return;
    term = new Terminal({
      fontFamily: "Cascadia Mono, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: SCROLLBACK,
      theme: termTheme(),
      // ConPTY tự wrap/reflow phía Windows; báo cho xterm để không reflow chồng lên.
      ...(navigator.userAgent.includes("Windows") ? { windowsPty: { backend: "conpty" as const } } : {}),
    });
    term.loadAddon(fit);
    term.open(host);
    term.onData((d) => {
      if (ptyId != null) api.termWrite(ptyId, d).catch(() => {});
    });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Ctrl+Shift+C copy vùng chọn (Ctrl+C phải dành cho SIGINT như terminal thật).
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c" && term!.hasSelection()) {
        void navigator.clipboard.writeText(term!.getSelection());
        return false;
      }
      // Ctrl+` là phím ẩn/hiện của App — không đẩy xuống shell.
      if (e.ctrlKey && e.key === "`") return false;
      return true;
    });

    const unOut = listen<{ id: number; data: string }>("term-output", (e) => {
      if (e.payload.id === ptyId) term!.write(b64(e.payload.data));
    });
    const unExit = listen<{ id: number }>("term-exit", (e) => {
      if (e.payload.id === ptyId) {
        setExited(true);
        // Không nhắc tên ký tự nút ở đây: nút đã là icon SVG, chữ phải mô tả chức năng.
        term!.writeln("\r\n\x1b[90m[phiên đã kết thúc — bấm nút khởi động lại ở góc trên]\x1b[0m");
      }
    });
    onCleanup(() => {
      unOut.then((f) => f());
      unExit.then((f) => f());
      if (ptyId != null) api.termKill(ptyId).catch(() => {});
    });
    await spawn();
  };

  onMount(() => {
    // Host đổi kích thước vì bất cứ lý do gì (kéo panel, kéo cửa sổ, đóng sidebar) → refit.
    const roHost = new ResizeObserver(() => refit());
    roHost.observe(host);
    // Vùng chứa đổi → cập nhật trần chiều cao (maximize / clamp khi cửa sổ nhỏ lại).
    const parent = panel.parentElement;
    const roParent = new ResizeObserver(() => {
      if (parent) setParentH(parent.clientHeight);
    });
    if (parent) {
      setParentH(parent.clientHeight);
      roParent.observe(parent);
    }
    onCleanup(() => {
      roHost.disconnect();
      roParent.disconnect();
      clearTimeout(resizeTimer);
    });
  });

  // Đổi theme: xterm cho phép gán lại options.theme nóng, không cần dựng lại phiên.
  createEffect(() => {
    const t = termTheme();
    if (term) term.options.theme = t;
  });

  createEffect(() => {
    if (props.visible) {
      ensure().then(() => {
        // Đợi layout áp display:flex rồi mới đo, không thì fit đọc kích thước 0.
        requestAnimationFrame(() => {
          refit();
          term?.focus();
        });
      });
    }
  });

  /** Kéo viền trên để đổi chiều cao (pointer capture để kéo nhanh ra ngoài vẫn bám). */
  const onResizeStart = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const startY = e.clientY;
    const startH = panelHeight();
    setMaxed(false);
    setResizing(true);
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setHeight(clampH(startH + (startY - ev.clientY)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setResizing(false);
      localStorage.setItem(HEIGHT_KEY, String(height()));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const toggleMax = () => {
    setMaxed((m) => !m);
    term?.focus();
  };

  return (
    <div
      class="term-panel"
      classList={{ resizing: resizing() }}
      ref={panel}
      style={{ display: props.visible ? "flex" : "none", height: `${panelHeight()}px` }}
    >
      <div
        class="term-resizer"
        title="Kéo để đổi chiều cao · đúp để maximize"
        onPointerDown={onResizeStart}
        onDblClick={toggleMax}
      />
      <div class="term-head">
        <span class="term-title"><IconTerminal /> Terminal — claude</span>
        <span class="term-hint">
          {exited() ? "phiên đã kết thúc" : "Ctrl+` ẩn/hiện · Ctrl+Shift+C copy · kéo viền trên để đổi chiều cao"}
        </span>
        <button title="Xoá màn hình" onClick={clear}><IconClear /></button>
        <button title={maxed() ? "Thu về kích thước cũ" : "Mở rộng tối đa"} onClick={toggleMax}>
          {maxed() ? <IconMinimize /> : <IconMaximize />}
        </button>
        <button title="Khởi động lại phiên" onClick={restart}><IconRestart /></button>
        <button title="Ẩn terminal" onClick={props.onClose}><IconClose /></button>
      </div>
      <div class="term-host" ref={host} />
    </div>
  );
}
