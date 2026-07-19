// Canvas: bảng tự do tương thích định dạng JSON Canvas của Obsidian (.canvas).
// Card text + card note; kéo thả, pan (kéo nền), zoom (Ctrl+lăn chuột),
// double-click nền tạo card text, tự lưu sau 600ms.
import { createSignal, For, onMount } from "solid-js";
import { api } from "./api";

export interface CanvasNode {
  id: string;
  type: "text" | "file";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
}

interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const uid = () => Math.random().toString(36).slice(2, 10);

export function CanvasView(props: {
  path: string;
  onOpenNote: (path: string) => void;
  requestNotePick: (cb: (path: string) => void) => void;
}) {
  const [doc, setDoc] = createSignal<CanvasDoc>({ nodes: [], edges: [] });
  const [scale, setScale] = createSignal(1);
  const [ox, setOx] = createSignal(0);
  const [oy, setOy] = createSignal(0);
  const [editing, setEditing] = createSignal<string | null>(null);
  let host!: HTMLDivElement;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(
      () => api.writeNote(props.path, JSON.stringify(doc(), null, "\t")).catch(() => {}),
      600,
    );
  };

  const mutate = (f: (d: CanvasDoc) => CanvasDoc) => {
    setDoc(f(doc()));
    scheduleSave();
  };

  onMount(async () => {
    try {
      const raw = await api.readNote(props.path);
      const parsed = JSON.parse(raw);
      setDoc({ nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] });
    } catch {
      setDoc({ nodes: [], edges: [] });
    }
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

  const onBgDown = (e: MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    panning = true;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onMove = (e: MouseEvent) => {
    if (panning) {
      setOx(ox() + e.clientX - lastX);
      setOy(oy() + e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
    } else if (dragId) {
      const w = toWorld(e.clientX, e.clientY);
      mutate((d) => ({
        ...d,
        nodes: d.nodes.map((n) =>
          n.id === dragId ? { ...n, x: Math.round(w.x - dragDx), y: Math.round(w.y - dragDy) } : n,
        ),
      }));
    }
  };
  const onUp = () => {
    panning = false;
    dragId = null;
  };
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setScale(Math.min(3, Math.max(0.2, scale() * factor)));
  };
  const onDblClick = (e: MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    const w = toWorld(e.clientX, e.clientY);
    const id = uid();
    mutate((d) => ({
      ...d,
      nodes: [
        ...d.nodes,
        { id, type: "text", x: Math.round(w.x) - 130, y: Math.round(w.y) - 40, width: 260, height: 90, text: "" },
      ],
    }));
    setEditing(id);
  };

  // ---- kéo card ----
  let dragId: string | null = null;
  let dragDx = 0;
  let dragDy = 0;
  const onCardDown = (e: MouseEvent, n: CanvasNode) => {
    if (editing() === n.id) return;
    e.stopPropagation();
    dragId = n.id;
    const w = toWorld(e.clientX, e.clientY);
    dragDx = w.x - n.x;
    dragDy = w.y - n.y;
  };

  const addNoteCard = () =>
    props.requestNotePick((path) => {
      mutate((d) => ({
        ...d,
        nodes: [
          ...d.nodes,
          {
            id: uid(),
            type: "file",
            x: Math.round(-ox() / scale()),
            y: Math.round(-oy() / scale()),
            width: 300,
            height: 140,
            file: path,
          },
        ],
      }));
    });

  const removeCard = (id: string) =>
    mutate((d) => ({
      nodes: d.nodes.filter((n) => n.id !== id),
      edges: d.edges.filter((e) => e.fromNode !== id && e.toNode !== id),
    }));

  const center = (id: string) => {
    const n = doc().nodes.find((x) => x.id === id);
    return n ? { x: n.x + n.width / 2, y: n.y + n.height / 2 } : { x: 0, y: 0 };
  };

  return (
    <div
      ref={host}
      class="canvas-host"
      onMouseDown={onBgDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onWheel={onWheel}
      onDblClick={onDblClick}
    >
      <div
        class="canvas-plane"
        style={{ transform: `translate(${ox()}px, ${oy()}px) scale(${scale()})` }}
      >
        <svg class="canvas-edges">
          <For each={doc().edges}>
            {(e) => {
              const a = center(e.fromNode);
              const b = center(e.toNode);
              return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
            }}
          </For>
        </svg>
        <For each={doc().nodes}>
          {(n) => (
            <div
              class="canvas-card"
              classList={{ "canvas-file": n.type === "file" }}
              style={{
                left: `${n.x}px`,
                top: `${n.y}px`,
                width: `${n.width}px`,
                "min-height": `${n.height}px`,
              }}
              onMouseDown={(e) => onCardDown(e, n)}
              onDblClick={(e) => {
                e.stopPropagation();
                if (n.type === "text") setEditing(n.id);
                else if (n.file) props.onOpenNote(n.file);
              }}
            >
              <button class="canvas-del" onClick={() => removeCard(n.id)}>×</button>
              {n.type === "file" ? (
                <div class="canvas-file-body">
                  <div class="canvas-file-name">📄 {n.file?.replace(/\.md$/i, "")}</div>
                  <div class="canvas-file-hint">double-click để mở</div>
                </div>
              ) : editing() === n.id ? (
                <textarea
                  class="canvas-textarea"
                  value={n.text ?? ""}
                  autofocus
                  onBlur={(e) => {
                    mutate((d) => ({
                      ...d,
                      nodes: d.nodes.map((x) =>
                        x.id === n.id ? { ...x, text: e.currentTarget.value } : x,
                      ),
                    }));
                    setEditing(null);
                  }}
                />
              ) : (
                <div class="canvas-text">{n.text || "…"}</div>
              )}
            </div>
          )}
        </For>
      </div>
      <div class="canvas-toolbar">
        <button
          onClick={(e) => {
            e.stopPropagation();
            const w = toWorld(host.getBoundingClientRect().width / 2 + host.getBoundingClientRect().left, 200);
            const id = uid();
            mutate((d) => ({
              ...d,
              nodes: [...d.nodes, { id, type: "text", x: Math.round(w.x), y: Math.round(w.y), width: 260, height: 90, text: "" }],
            }));
            setEditing(id);
          }}
        >
          ＋ Card
        </button>
        <button onClick={addNoteCard}>＋ Note</button>
        <span class="canvas-hint">double-click nền tạo card · Ctrl+lăn chuột zoom · kéo nền để pan</span>
      </div>
    </div>
  );
}
