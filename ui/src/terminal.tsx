import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { listen } from "@tauri-apps/api/event";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { api } from "./api";

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
      theme: {
        background: "#14161d",
        foreground: "#c7cddd",
        cursor: "#a48fff",
        selectionBackground: "#a48fff44",
      },
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
        term!.writeln("\r\n\x1b[90m[phiên đã kết thúc — bấm ⟳ để mở lại]\x1b[0m");
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
        <span class="term-title">⌨ Terminal — claude</span>
        <span class="term-hint">{exited() ? "phiên đã kết thúc" : "Ctrl+` để ẩn/hiện"}</span>
        <button title="Khởi động lại phiên" onClick={restart}>⟳</button>
        <button title="Ẩn terminal" onClick={props.onClose}>×</button>
      </div>
      <div class="term-host" ref={host} />
    </div>
  );
}
