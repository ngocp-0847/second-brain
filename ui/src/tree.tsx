// Cây thư mục dựng từ danh sách path phẳng của vault.
import { createMemo, For, Show } from "solid-js";
import type { NoteMeta } from "./api";

interface DirNode {
  name: string;
  dirs: DirNode[];
  files: NoteMeta[];
}

function buildTree(notes: NoteMeta[]): DirNode {
  const root: DirNode = { name: "", dirs: [], files: [] };
  const dirMap = new Map<string, DirNode>([["", root]]);

  const getDir = (path: string): DirNode => {
    const found = dirMap.get(path);
    if (found) return found;
    const idx = path.lastIndexOf("/");
    const parent = getDir(idx >= 0 ? path.slice(0, idx) : "");
    const node: DirNode = { name: path.slice(idx + 1), dirs: [], files: [] };
    parent.dirs.push(node);
    dirMap.set(path, node);
    return node;
  };

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

function Dir(props: { node: DirNode; current: string | null; onOpen: (p: string) => void }) {
  return (
    <>
      <For each={props.node.dirs}>
        {(d) => (
          <details open>
            <summary class="tree-dir">{d.name}</summary>
            <div class="tree-indent">
              <Dir node={d} current={props.current} onOpen={props.onOpen} />
            </div>
          </details>
        )}
      </For>
      <For each={props.node.files}>
        {(f) => (
          <div
            class="tree-file"
            classList={{ active: props.current === f.path }}
            onClick={() => props.onOpen(f.path)}
            title={f.path}
          >
            {fileName(f.path)}
          </div>
        )}
      </For>
    </>
  );
}

export function Tree(props: {
  notes: NoteMeta[];
  filter: string;
  current: string | null;
  onOpen: (p: string) => void;
}) {
  const filtered = createMemo(() => {
    const q = props.filter.trim().toLowerCase();
    if (!q) return props.notes;
    return props.notes.filter(
      (n) => n.path.toLowerCase().includes(q) || n.title.toLowerCase().includes(q),
    );
  });
  const tree = createMemo(() => buildTree(filtered()));

  return (
    <div class="tree">
      <Show when={filtered().length === 0}>
        <div class="tree-empty">Không có note nào</div>
      </Show>
      <Dir node={tree()} current={props.current} onOpen={props.onOpen} />
    </div>
  );
}
