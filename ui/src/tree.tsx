// Cây thư mục dựng từ danh sách path phẳng của vault (kèm folder rỗng từ dirs).
// Note (.md) và canvas (.canvas) nằm CHUNG một cây — canvas chỉ khác ở cái badge.
import { createMemo, For, Show } from "solid-js";
import type { NoteMeta } from "./api";
import { beginDrag, consumeDragClick, dragPath, dropDir } from "./dnd";
import { IconDirArrow } from "./icons";

export interface TreeEditing {
  path: string;
  kind: "note" | "dir";
}

/** Một file trong cây. `canvas` để hiện badge và mở đúng view. */
export interface TreeFile extends NoteMeta {
  canvas?: boolean;
}

interface DirNode {
  name: string;
  path: string;
  dirs: DirNode[];
  files: TreeFile[];
}

function buildTree(notes: TreeFile[], dirs: string[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: [], files: [] };
  const dirMap = new Map<string, DirNode>([["", root]]);

  const getDir = (path: string): DirNode => {
    const found = dirMap.get(path);
    if (found) return found;
    const idx = path.lastIndexOf("/");
    const parent = getDir(idx >= 0 ? path.slice(0, idx) : "");
    const node: DirNode = { name: path.slice(idx + 1), path, dirs: [], files: [] };
    parent.dirs.push(node);
    dirMap.set(path, node);
    return node;
  };

  for (const d of dirs) getDir(d);
  for (const n of notes) {
    const idx = n.path.lastIndexOf("/");
    getDir(idx >= 0 ? n.path.slice(0, idx) : "").files.push(n);
  }
  const sortNode = (d: DirNode) => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name));
    d.files.sort((a, b) => a.path.localeCompare(b.path));
    d.dirs.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function fileName(path: string) {
  return path.split("/").pop()!.replace(/\.(md|canvas)$/i, "");
}

/** Thư mục cha của một path ("" = gốc vault). */
export const parentDir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** Ô nhập tên inline khi vừa tạo note/folder: Enter/blur xác nhận, Esc giữ tên hiện tại. */
function RenameInput(props: { value: string; onCommit: (v: string) => void }) {
  let committed = false;
  const commit = (v: string) => {
    if (committed) return;
    committed = true;
    props.onCommit(v);
  };
  return (
    <input
      class="tree-rename"
      value={props.value}
      ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          commit(props.value);
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

interface DirProps {
  node: DirNode;
  current: string | null;
  editing: TreeEditing | null;
  /** Đang lọc thì bung hết folder để thấy kết quả, bỏ qua closedDirs. */
  filtering: boolean;
  closedDirs: Set<string>;
  onOpen: (p: string) => void;
  onOpenNewTab?: (p: string) => void;
  onRename: (v: string) => void;
  onToggleDir: (path: string, open: boolean) => void;
  onContextNote?: (e: MouseEvent, path: string) => void;
  onContextDir?: (e: MouseEvent, path: string) => void;
}

// Kéo-thả đi qua ./dnd (pointer event), không dùng HTML5 drag-and-drop: WebView2
// ở app này không bắn dragstart. Vùng nhận thả chỉ cần đánh dấu data-drop-dir,
// dnd tự tìm bằng elementFromPoint.

function Dir(props: DirProps) {
  return (
    <>
      <For each={props.node.dirs}>
        {(d) => (
          // Vùng nhận thả là CẢ khối details (kể cả phần thụt lề bên trong), nên
          // thả vào khoảng trống trong folder cũng vào đúng folder đó. Folder
          // lồng nhau: elementFromPoint trả về element sâu nhất nên closest()
          // tìm ra cái trong cùng.
          <details
            data-drop-dir={d.path}
            open={props.filtering || !props.closedDirs.has(d.path)}
            onToggle={(e) => {
              // Lúc đang lọc, mọi folder bị ép mở — đừng ghi đè lựa chọn của user.
              if (props.filtering) return;
              props.onToggleDir(d.path, e.currentTarget.open);
            }}
          >
            <summary
              class="tree-dir"
              classList={{ "drop-target": dropDir() === d.path }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                props.onContextDir?.(e, d.path);
              }}
            >
              <IconDirArrow class="tree-dir-arrow" />
              <Show
                when={props.editing?.kind === "dir" && props.editing.path === d.path}
                fallback={d.name}
              >
                <RenameInput value={d.name} onCommit={props.onRename} />
              </Show>
            </summary>
            <div class="tree-indent">
              <Dir {...props} node={d} />
            </div>
          </details>
        )}
      </For>
      <For each={props.node.files}>
        {(f) => (
          <div
            class="tree-file"
            // `dragging`: dòng đang được nhấc lên — nhìn vào là biết bóng theo
            // con trỏ là file nào.
            classList={{ active: props.current === f.path, dragging: dragPath() === f.path }}
            // Dùng cho "Hiện trong sidebar": tìm đúng dòng để cuộn tới.
            data-path={f.path}
            onPointerDown={(e) => beginDrag(e, f.path, fileName(f.path))}
            onClick={(e) => {
              // Vừa kéo xong thì pointerup vẫn sinh ra click — đừng mở note.
              if (consumeDragClick()) return;
              if (e.ctrlKey && props.onOpenNewTab) props.onOpenNewTab(f.path);
              else props.onOpen(f.path);
            }}
            onAuxClick={(e) => e.button === 1 && props.onOpenNewTab?.(f.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              props.onContextNote?.(e, f.path);
            }}
            title={f.path}
          >
            <Show
              when={props.editing?.kind === "note" && props.editing.path === f.path}
              fallback={fileName(f.path)}
            >
              <RenameInput value={fileName(f.path)} onCommit={props.onRename} />
            </Show>
            <Show when={f.canvas}>
              <span class="canvas-badge">CANVAS</span>
            </Show>
          </div>
        )}
      </For>
    </>
  );
}

export function Tree(props: {
  /** Note và canvas trộn chung; canvas đánh dấu bằng `canvas: true`. */
  notes: TreeFile[];
  dirs: string[];
  filter: string;
  current: string | null;
  editing: TreeEditing | null;
  closedDirs: Set<string>;
  onOpen: (p: string) => void;
  onOpenNewTab?: (p: string) => void;
  onRename: (v: string) => void;
  onToggleDir: (path: string, open: boolean) => void;
  onContextNote?: (e: MouseEvent, path: string) => void;
  onContextDir?: (e: MouseEvent, path: string) => void;
  /** Chuột phải vào khoảng trống của tree = thao tác ở gốc vault. */
  onContextRoot?: (e: MouseEvent) => void;
}) {
  const filtered = createMemo(() => {
    const q = props.filter.trim().toLowerCase();
    if (!q) return props.notes;
    return props.notes.filter(
      (n) => n.path.toLowerCase().includes(q) || n.title.toLowerCase().includes(q),
    );
  });
  // Khi đang lọc thì ẩn folder rỗng cho gọn.
  const tree = createMemo(() =>
    buildTree(filtered(), props.filter.trim() ? [] : props.dirs),
  );

  return (
    <div
      class="tree"
      // Thả ra vùng trống = đưa file về gốc vault. data-drop-dir="" phải ở
      // NGOÀI cùng để closest() của folder con thắng trước.
      data-drop-dir=""
      classList={{ "drop-target": dropDir() === "" }}
      // Note/folder đã stopPropagation, nên tới đây chỉ còn chuột phải vào
      // khoảng trống — kể cả khi rơi vào .tree-indent của một folder.
      onContextMenu={(e) => {
        e.preventDefault();
        props.onContextRoot?.(e);
      }}
    >
      <Show when={filtered().length === 0 && props.dirs.length === 0}>
        <div class="tree-empty">Không có note nào</div>
      </Show>
      <Dir
        node={tree()}
        current={props.current}
        editing={props.editing}
        filtering={!!props.filter.trim()}
        closedDirs={props.closedDirs}
        onOpen={props.onOpen}
        onOpenNewTab={props.onOpenNewTab}
        onRename={props.onRename}
        onToggleDir={props.onToggleDir}
        onContextNote={props.onContextNote}
        onContextDir={props.onContextDir}
      />
    </div>
  );
}
