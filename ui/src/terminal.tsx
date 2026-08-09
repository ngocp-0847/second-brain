import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { api } from "./api";
import { IconClose, IconRestart, IconTerminal } from "./icons";
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

/** Panel terminal dưới cùng: PTY thật (ConPTY) chạy PowerShell trong vault và tự gõ
 *  `claude` — dùng Claude Code tương tác ngay trong app. Ẩn/hiện không giết phiên. */
export function TermPanel(props: { visible: boolean; onClose: () => void }) {
  let host!: HTMLDivElement;
  let term: Terminal | undefined;
  const fit = new FitAddon();
  let ptyId: number | null = null;
  const [exited, setExited] = createSignal(false);

  const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

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

  const ensure = async () => {
    if (term) return;
    term = new Terminal({
      fontFamily: "Cascadia Mono, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: termTheme(),
    });
    term.loadAddon(fit);
    term.open(host);
    term.onData((d) => {
      if (ptyId != null) api.termWrite(ptyId, d).catch(() => {});
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
    const ro = new ResizeObserver(() => {
      if (!props.visible || !term) return;
      fit.fit();
      if (ptyId != null) api.termResize(ptyId, term.cols, term.rows).catch(() => {});
    });
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  // Đổi theme: xterm cho phép gán lại options.theme nóng, không cần dựng lại phiên.
  createEffect(() => {
    const t = termTheme();
    if (term) term.options.theme = t;
  });

  createEffect(() => {
    if (props.visible) {
      ensure().then(() => {
        fit.fit();
        if (ptyId != null && term) api.termResize(ptyId, term.cols, term.rows).catch(() => {});
        term?.focus();
      });
    }
  });

  return (
    <div class="term-panel" style={{ display: props.visible ? "flex" : "none" }}>
      <div class="term-head">
        <span class="term-title"><IconTerminal /> Terminal — claude</span>
        <span class="term-hint">{exited() ? "phiên đã kết thúc" : "Ctrl+` để ẩn/hiện"}</span>
        <button title="Khởi động lại phiên" onClick={restart}><IconRestart /></button>
        <button title="Ẩn terminal" onClick={props.onClose}><IconClose /></button>
      </div>
      <div class="term-host" ref={host} />
    </div>
  );
}
