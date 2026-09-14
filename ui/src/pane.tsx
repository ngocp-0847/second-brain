// Pane phụ của khu vực chính — "Split right" / "Split down" của Obsidian.
//
// Pane chính giữ nguyên bộ tab + lịch sử điều hướng; pane này cố tình đơn giản:
// mỗi lúc xem đúng MỘT file, có header riêng, editor riêng (một EditorView nữa),
// và tự lưu như pane chính. Cùng một note mở ở hai pane thì App lo đồng bộ nội
// dung hai bên sau mỗi lần lưu.
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { api, type NoteMeta } from "./api";
import { isImagePath } from "./assets";
import { createEditor, type EditorHandle, type EditorMode } from "./editor";
import { IconClose, IconMore, IconReading, IconSource } from "./icons";
import { ImageView } from "./imageview";

/** Thanh đường dẫn kiểu Obsidian: bấm vào một thư mục để nhảy tới nó trong sidebar. */
export function Crumbs(props: {
  path: string;
  onOpenDir?: (dir: string) => void;
  /** Bấm vào tên file (chặng cuối) — thường là "hiện trong sidebar". */
  onOpenFile?: () => void;
}) {
  const parts = () => props.path.split("/");
  return (
    <span class="crumbs" title={props.path}>
      {parts().map((seg, i) => {
        const last = i === parts().length - 1;
        const dir = parts().slice(0, i + 1).join("/");
        return (
          <>
            <Show when={i > 0}>
              <span class="crumb-sep">/</span>
            </Show>
            <span
              class="crumb"
              classList={{ last }}
              onClick={() => (last ? props.onOpenFile?.() : props.onOpenDir?.(dir))}
            >
              {last ? seg.replace(/\.(md|canvas)$/i, "") : seg}
            </span>
          </>
        );
      })}
    </span>
  );
}

export interface SplitPaneProps {
  path: string;
  /** "right" = cạnh nhau, "down" = trên dưới. Chỉ để hiện tooltip/nhãn. */
  dir: "right" | "down";
  dark: boolean;
  getNotes: () => NoteMeta[];
  /** Lưu file của pane này — App dùng chung đường lưu với pane chính. */
  onSave: (path: string, content: string) => void;
  /** Ctrl+Click wikilink trong pane này → mở ngay TRONG pane này. */
  onOpenLink: (target: string) => void;
  onMenu: (e: MouseEvent, path: string) => void;
  onOpenDir?: (dir: string) => void;
  onClose: () => void;
  /** Trao handle cho App để đồng bộ nội dung / flush trước khi đóng (null = đã huỷ). */
  onReady: (h: EditorHandle | null) => void;
}

export function SplitPane(props: SplitPaneProps) {
  let host!: HTMLDivElement;
  let ed: EditorHandle | undefined;
  // Path mà editor ĐANG hiện — callback onSave của CodeMirror bắn ra không kèm
  // path, mà props.path có thể đã đổi trong lúc autosave chờ 800ms.
  let shown = props.path;
  const [mode, setMode] = createSignal<EditorMode>("live");
  const [err, setErr] = createSignal<string | null>(null);

  const isCanvas = (p: string) => p.toLowerCase().endsWith(".canvas");
  const kind = () =>
    isImagePath(props.path) ? "image" : isCanvas(props.path) ? "canvas" : "note";

  onMount(() => {
    ed = createEditor({
      parent: host,
      dark: props.dark,
      getNotes: props.getNotes,
      onSave: (content) => props.onSave(shown, content),
      onOpenLink: props.onOpenLink,
    });
    props.onReady(ed);
    onCleanup(() => {
      ed?.flush();
      props.onReady(null);
      ed?.destroy();
    });
  });

  createEffect(() => {
    const p = props.path;
    setErr(null);
    if (kind() !== "note") {
      shown = p;
      return;
    }
    // Đổi file: lưu file cũ trước đã, autosave đang chờ sẽ ghi nhầm vào file mới.
    ed?.flush();
    api
      .readNote(p)
      .then((content) => {
        shown = p;
        ed?.setContent(content);
        ed?.setTitle(p.split("/").pop()!.replace(/\.md$/i, ""));
      })
      .catch((e) => setErr(String(e)));
  });

  createEffect(() => ed?.setDark(props.dark));

  const cycleReading = () => {
    const next: EditorMode = mode() === "reading" ? "live" : "reading";
    setMode(next);
    ed?.setMode(next);
  };

  return (
    <div class="pane pane-split" classList={{ down: props.dir === "down" }}>
      <div class="note-header">
        <Crumbs path={props.path} onOpenDir={props.onOpenDir} />
        <Show when={kind() === "note"}>
          <button
            title={mode() === "reading" ? "Về chế độ sửa" : "Reading view"}
            onClick={cycleReading}
          >
            {mode() === "reading" ? <IconSource /> : <IconReading />}
          </button>
          <button title="Thêm hành động" onClick={(e) => props.onMenu(e, props.path)}>
            <IconMore />
          </button>
        </Show>
        <button title="Đóng pane này" onClick={props.onClose}>
          <IconClose />
        </button>
      </div>

      <Show when={err()}>
        <div class="pane-msg">{err()}</div>
      </Show>
      <div
        class="editor-host"
        ref={host}
        style={{ display: kind() === "note" && !err() ? "block" : "none" }}
      />
      <Show when={kind() === "image"}>
        <ImageView path={props.path} />
      </Show>
      <Show when={kind() === "canvas"}>
        <div class="pane-msg">Canvas chỉ mở được ở pane chính.</div>
      </Show>
    </div>
  );
}
