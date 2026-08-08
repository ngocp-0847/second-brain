// Cây thư mục dựng từ danh sách path phẳng của vault (kèm folder rỗng từ dirs).
import { createMemo, For, Show } from "solid-js";
import type { NoteMeta } from "./api";

export interface TreeEditing {
  path: string;
  kind: "note" | "dir";
}

interface DirNode {
  name: string;
  path: string;
  dirs: DirNode[];
  files: NoteMeta[];
}

function buildTree(notes: NoteMeta[], dirs: string[]): DirNode {
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
  return path.split("/").pop()!.replace(/\.md$/i, "");
}

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
}

function Dir(props: DirProps) {
  return (
    <>
      <For each={props.node.dirs}>
        {(d) => (
          <details
            open={props.filtering || !props.closedDirs.has(d.path)}
            onToggle={(e) => {
              // Lúc đang lọc, mọi folder bị ép mở — đừng ghi đè lựa chọn của user.
              if (props.filtering) return;
              props.onToggleDir(d.path, e.currentTarget.open);
            }}
          >
            <summary class="tree-dir">
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
            classList={{ active: props.current === f.path }}
            onClick={(e) =>
              e.ctrlKey && props.onOpenNewTab
                ? props.onOpenNewTab(f.path)
                : props.onOpen(f.path)
            }
            onAuxClick={(e) => e.button === 1 && props.onOpenNewTab?.(f.path)}
            title={f.path}
          >
            <Show
              when={props.editing?.kind === "note" && props.editing.path === f.path}
              fallback={fileName(f.path)}
            >
              <RenameInput value={fileName(f.path)} onCommit={props.onRename} />
            </Show>
          </div>
        )}
      </For>
    </>
  );
}

export function Tree(props: {
  notes: NoteMeta[];
  dirs: string[];
  filter: string;
  current: string | null;
  editing: TreeEditing | null;
  closedDirs: Set<string>;
  onOpen: (p: string) => void;
  onOpenNewTab?: (p: string) => void;
  onRename: (v: string) => void;
  onToggleDir: (path: string, open: boolean) => void;
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
    <div class="tree">
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
      />
    </div>
  );
}
