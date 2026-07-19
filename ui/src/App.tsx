import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  api,
  type AnswerDto,
  type Backlink,
  type JanitorReport,
  type LlmSettings,
  type NoteMeta,
  type RelatedNote,
  type SearchHit,
  type Stats,
} from "./api";
import { CanvasView } from "./canvas";
import { createEditor, type EditorHandle } from "./editor";
import { GraphView } from "./graph";
import { Tree } from "./tree";

type View = "editor" | "graph" | "canvas";

export default function App() {
  const [root, setRoot] = createSignal<string | null>(null);
  const [notes, setNotes] = createSignal<NoteMeta[]>([]);
  const [stats, setStats] = createSignal<Stats | null>(null);
  const [current, setCurrent] = createSignal<string | null>(null);
  const [backlinks, setBacklinks] = createSignal<Backlink[]>([]);
  const [related, setRelated] = createSignal<RelatedNote[]>([]);
  const [mentions, setMentions] = createSignal<SearchHit[]>([]);
  const [filter, setFilter] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [semStatus, setSemStatus] = createSignal("");

  // Omnibar (Ctrl+K)
  const [omniOpen, setOmniOpen] = createSignal(false);
  const [omniQuery, setOmniQuery] = createSignal("");
  const [omniHits, setOmniHits] = createSignal<SearchHit[]>([]);
  const [omniSel, setOmniSel] = createSignal(0);

  // Hỏi đáp (prefix "?")
  const [asking, setAsking] = createSignal(false);
  const [answer, setAnswer] = createSignal<AnswerDto | null>(null);
  const [askedQuestion, setAskedQuestion] = createSignal("");
  const isAskMode = () => omniQuery().trimStart().startsWith("?");

  // View chính: editor / graph / canvas
  const [view, setView] = createSignal<View>("editor");
  const [canvasPath, setCanvasPath] = createSignal<string | null>(null);
  const [canvases, setCanvases] = createSignal<string[]>([]);

  // Settings + Janitor
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [llm, setLlm] = createSignal<LlmSettings | null>(null);
  const [janitorOpen, setJanitorOpen] = createSignal(false);
  const [janitorReport, setJanitorReport] = createSignal<JanitorReport | null>(null);
  const [janitorBusy, setJanitorBusy] = createSignal(false);
  const [janitorBadge, setJanitorBadge] = createSignal(false);

  // Modal nhập text (thay window.prompt vốn không chạy trong WebView)
  const [promptCfg, setPromptCfg] = createSignal<{
    title: string;
    value: string;
    onOk: (v: string) => void;
  } | null>(null);

  let editorHost!: HTMLDivElement;
  let editor: EditorHandle;
  let omniInput: HTMLInputElement | undefined;
  let currentPath: string | null = null; // bản sao cho closure của editor

  const say = (msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus((s) => (s === msg ? "" : s)), 4000);
  };

  const applyInfo = (info: { root: string; notes: NoteMeta[]; stats: Stats }) => {
    setRoot(info.root);
    setNotes(info.notes);
    setStats(info.stats);
  };

  const openVaultAt = async (path: string) => {
    try {
      applyInfo(await api.openVault(path));
      localStorage.setItem("vaultPath", path);
      setCanvases(await api.listCanvases().catch(() => []));
      say(`Đã mở vault (${stats()!.notes} notes, index ${stats()!.index_ms}ms)`);
    } catch (e) {
      say(String(e));
    }
  };

  const pickVault = async () => {
    const dir = await openDialog({ directory: true, title: "Chọn thư mục vault" });
    if (typeof dir === "string") await openVaultAt(dir);
  };

  const loadPanels = async (path: string) => {
    setBacklinks(await api.backlinks(path).catch(() => []));
    setMentions(await api.unlinkedMentions(path).catch(() => []));
    setRelated(await api.relatedNotes(path).catch(() => []));
  };

  const openNote = async (path: string) => {
    if (currentPath) editor.flush();
    try {
      const content = await api.readNote(path);
      currentPath = path;
      setCurrent(path);
      setView("editor");
      editor.setContent(content);
      loadPanels(path);
    } catch (e) {
      say(String(e));
    }
  };

  const openCanvas = (path: string) => {
    if (currentPath) editor.flush();
    setCanvasPath(path);
    setView("canvas");
  };

  /** Mở (hoặc tạo) daily note hôm nay: Daily/YYYY-MM-DD.md */
  const openDaily = async () => {
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const path = `Daily/${iso}.md`;
    if (notes().some((n) => n.path === path)) {
      await openNote(path);
    } else {
      try {
        const rel = await api.createNote(path);
        applyInfo(await api.refresh());
        await openNote(rel);
      } catch (e) {
        say(String(e));
      }
    }
  };

  const newCanvas = () =>
    setPromptCfg({
      title: "Tên canvas mới",
      value: "",
      onOk: async (name) => {
        if (!name.trim()) return;
        const path = `${name.trim().replace(/\.canvas$/i, "")}.canvas`;
        try {
          await api.writeNote(path, JSON.stringify({ nodes: [], edges: [] }));
          setCanvases(await api.listCanvases().catch(() => []));
          openCanvas(path);
        } catch (e) {
          say(String(e));
        }
      },
    });

  const openByTarget = async (target: string) => {
    const path = await api.resolveLink(target);
    if (path) await openNote(path);
    else {
      // Link chưa tồn tại → tạo note mới ngay tại gốc vault, giống Obsidian.
      try {
        const rel = await api.createNote(target);
        setNotes((await api.refresh()).notes);
        await openNote(rel);
      } catch (e) {
        say(String(e));
      }
    }
  };

  const saveCurrent = async (content: string) => {
    if (!currentPath) return;
    try {
      await api.writeNote(currentPath, content);
      setStatus("Đã lưu ✓");
      setTimeout(() => setStatus((s) => (s === "Đã lưu ✓" ? "" : s)), 1500);
      loadPanels(currentPath);
      const info = await api.refresh();
      applyInfo(info);
    } catch (e) {
      say(String(e));
    }
  };

  const newNote = () =>
    setPromptCfg({
      title: "Tên note mới (có thể kèm folder, vd: Tech/Rust)",
      value: "",
      onOk: async (name) => {
        if (!name.trim()) return;
        try {
          const rel = await api.createNote(name.trim());
          applyInfo(await api.refresh());
          await openNote(rel);
        } catch (e) {
          say(String(e));
        }
      },
    });

  const renameCurrent = () => {
    const from = current();
    if (!from) return;
    setPromptCfg({
      title: "Đường dẫn mới (link trỏ tới sẽ tự cập nhật)",
      value: from,
      onOk: async (to) => {
        if (!to.trim() || to === from) return;
        try {
          editor.flush();
          const n = await api.renameNote(from, to.trim());
          applyInfo(await api.refresh());
          const newPath = to.trim().toLowerCase().endsWith(".md") ? to.trim() : to.trim() + ".md";
          currentPath = null;
          await openNote(newPath.replace(/\\/g, "/"));
          say(`Đã đổi tên, rewrite ${n} link trỏ tới`);
        } catch (e) {
          say(String(e));
        }
      },
    });
  };

  const trashCurrent = () => {
    const path = current();
    if (!path) return;
    setPromptCfg({
      title: `Gõ "xoa" để chuyển "${path}" vào thùng rác (.brain/trash)`,
      value: "",
      onOk: async (v) => {
        if (v.trim().toLowerCase() !== "xoa") return;
        try {
          await api.trashNote(path);
          currentPath = null;
          setCurrent(null);
          editor.setContent("");
          applyInfo(await api.refresh());
          say("Đã chuyển vào thùng rác");
        } catch (e) {
          say(String(e));
        }
      },
    });
  };

  // Omnibar: lọc theo title trước, gọi FTS song song
  let omniTimer: ReturnType<typeof setTimeout>;
  createEffect(() => {
    const q = omniQuery();
    if (!omniOpen() || isAskMode()) return;
    clearTimeout(omniTimer);
    if (!q.trim()) {
      setOmniHits([]);
      return;
    }
    omniTimer = setTimeout(async () => {
      try {
        setOmniHits(await api.search(q, 15));
        setOmniSel(0);
      } catch {
        setOmniHits([]);
      }
    }, 120);
  });

  const omniTitleMatches = () => {
    const q = omniQuery().trim().toLowerCase();
    if (!q) return notes().slice(0, 12);
    return notes()
      .filter((n) => n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
      .slice(0, 6);
  };

  const CREATE_SENTINEL = " create";

  const omniItems = () => {
    const titles = omniTitleMatches().map((n) => ({ path: n.path, label: n.title, sub: n.path, line: 0 }));
    const seen = new Set(titles.map((t) => t.path));
    const contents = omniHits()
      .filter((h) => !seen.has(h.path))
      .map((h) => ({
        path: h.path,
        label: h.title,
        sub: h.snippet.replace(/[»«]/g, ""),
        line: h.start_line,
      }));
    const items = [...titles, ...contents];
    // "Find or create": luôn có lối tạo note mới từ chính query.
    const q = omniQuery().trim();
    if (q && !items.some((i) => i.label.toLowerCase() === q.toLowerCase())) {
      items.push({
        path: CREATE_SENTINEL,
        label: `＋ Tạo note "${q}"`,
        sub: "Enter để tạo và mở",
        line: 0,
      });
    }
    return items;
  };

  const omniPick = async (i: number) => {
    const item = omniItems()[i];
    if (!item) return;
    setOmniOpen(false);
    if (item.path === CREATE_SENTINEL) {
      try {
        const rel = await api.createNote(omniQuery().trim());
        applyInfo(await api.refresh());
        await openNote(rel);
      } catch (e) {
        say(String(e));
      }
      return;
    }
    await openNote(item.path);
  };

  const doAsk = async () => {
    const q = omniQuery().trimStart().replace(/^\?\s*/, "").trim();
    if (!q || asking()) return;
    setAsking(true);
    setAnswer(null);
    setAskedQuestion(q);
    try {
      setAnswer(await api.ask(q));
    } catch (e) {
      setAnswer({ answer: String(e), provider: "lỗi", sources: [] });
    } finally {
      setAsking(false);
    }
  };

  const openWiki = async (target: string) => {
    setOmniOpen(false);
    await openByTarget(target);
  };

  /** Render answer: [[wikilink]] thành link bấm được, còn lại text thuần. */
  const answerParts = () => {
    const a = answer();
    if (!a) return [];
    return a.answer.split(/(\[\[[^\[\]]+?\]\])/g).map((seg) => {
      const m = seg.match(/^\[\[([^\[\]]+?)\]\]$/);
      if (!m) return { text: seg, target: null as string | null };
      const inner = m[1];
      const target = (inner.split("|")[0] ?? inner).split("#")[0].trim();
      const label = inner.includes("|") ? inner.split("|")[1] : inner;
      return { text: label, target };
    });
  };

  const openSettings = async () => {
    setSettingsOpen(true);
    try {
      setLlm(await api.getLlmSettings());
    } catch (e) {
      say(String(e));
    }
  };

  const choosePref = async (pref: string) => {
    try {
      await api.setLlmPref(pref);
      localStorage.setItem("llmPref", pref);
      setLlm(await api.getLlmSettings());
    } catch (e) {
      say(String(e));
    }
  };

  const runJanitor = async () => {
    setJanitorOpen(true);
    setJanitorBusy(true);
    try {
      setJanitorReport(await api.janitorRun());
      applyInfo(await api.refresh());
    } catch (e) {
      say(String(e));
    } finally {
      setJanitorBusy(false);
    }
  };

  const janitorAct = async (id: number, apply: boolean) => {
    try {
      if (apply) {
        const msg = await api.janitorApply(id);
        say(msg);
      } else {
        await api.janitorDismiss(id);
      }
      setJanitorReport(await api.janitorLatest());
      applyInfo(await api.refresh());
      if (current()) loadPanels(current()!);
    } catch (e) {
      say(String(e));
    }
  };

  const saveAnswerAsNote = async () => {
    const a = answer();
    if (!a) return;
    const slug = askedQuestion()
      .replace(/[\\/:*?"<>|#^\[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    try {
      const rel = await api.createNote(`QA/${slug}`);
      const srcs = [...new Set(a.sources.map((s) => `- [[${s.path.replace(/\.md$/i, "")}]]`))];
      await api.writeNote(
        rel,
        `# ${askedQuestion()}\n\n${a.answer}\n\n## Nguồn\n${srcs.join("\n")}\n`,
      );
      applyInfo(await api.refresh());
      setOmniOpen(false);
      await openNote(rel);
    } catch (e) {
      say(String(e));
    }
  };

  onMount(() => {
    editor = createEditor({
      parent: editorHost,
      getNotes: notes,
      onSave: saveCurrent,
      onOpenLink: openByTarget,
    });

    const saved = localStorage.getItem("vaultPath");
    if (saved) openVaultAt(saved);

    // Tiến độ & trạng thái embedding từ worker semantic.
    const unlistenProgress = listen<[number, number]>("semantic-progress", (e) => {
      const [done, total] = e.payload;
      setSemStatus(done < total ? `embedding ${done}/${total}` : "");
    });
    const unlistenStatus = listen<string>("semantic-status", (e) => setSemStatus(e.payload));
    const unlistenJanitor = listen<JanitorReport>("janitor-report-ready", (e) => {
      setJanitorReport(e.payload);
      setJanitorBadge(true);
    });
    onCleanup(() => {
      unlistenProgress.then((f) => f());
      unlistenStatus.then((f) => f());
      unlistenJanitor.then((f) => f());
    });

    // Khôi phục lựa chọn LLM provider.
    const pref = localStorage.getItem("llmPref");
    if (pref) api.setLlmPref(pref).catch(() => {});

    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && ["k", "o", "p"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        setOmniOpen(true);
        setOmniQuery("");
        setAnswer(null);
        queueMicrotask(() => omniInput?.focus());
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setView(view() === "graph" ? "editor" : "graph");
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        editor.flush();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newNote();
      } else if (e.key === "Escape") {
        setOmniOpen(false);
        setPromptCfg(null);
        setSettingsOpen(false);
        setJanitorOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      editor.destroy();
    });
  });

  return (
    <div class="app">
      <nav class="ribbon">
        <button title="Tìm hoặc tạo note (Ctrl+K / Ctrl+O)" onClick={() => { setOmniOpen(true); setOmniQuery(""); setAnswer(null); queueMicrotask(() => omniInput?.focus()); }}>🔍</button>
        <button title="Hỏi đáp vault" onClick={() => { setOmniOpen(true); setOmniQuery("? "); setAnswer(null); queueMicrotask(() => omniInput?.focus()); }}>💬</button>
        <button title="Graph view (Ctrl+G)" classList={{ active: view() === "graph" }} onClick={() => setView(view() === "graph" ? "editor" : "graph")}>🕸</button>
        <button title="Daily note hôm nay" onClick={openDaily}>📅</button>
        <button title="Canvas mới" onClick={newCanvas}>🧩</button>
        <button title="Janitor: lint & dọn dẹp" onClick={runJanitor}>🧹</button>
        <div class="ribbon-spacer" />
        <button title="Mở vault khác" onClick={pickVault}>🗂</button>
        <button title="Settings" onClick={openSettings}>⚙</button>
      </nav>

      <aside class="sidebar">
        <div class="sidebar-head">
          <button title="Note mới (Ctrl+N)" onClick={newNote}>＋</button>
          <button
            title="Re-index"
            onClick={async () => {
              applyInfo(await api.refresh());
              setCanvases(await api.listCanvases().catch(() => []));
              say(`Re-indexed (${stats()?.index_ms}ms)`);
            }}
          >
            ⟳
          </button>
          <input
            class="quick-filter"
            placeholder="Lọc nhanh…"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
        </div>
        <Show when={root()} fallback={<div class="tree-empty">Chưa mở vault</div>}>
          <div class="tree-scroll">
            <Tree notes={notes()} filter={filter()} current={current()} onOpen={openNote} />
            <Show when={canvases().length > 0}>
              <div class="panel-title">Canvas</div>
              <For each={canvases()}>
                {(c) => (
                  <div
                    class="tree-file canvas-item"
                    classList={{ active: view() === "canvas" && canvasPath() === c }}
                    onClick={() => openCanvas(c)}
                  >
                    {c.replace(/\.canvas$/i, "")}
                    <span class="canvas-badge">CANVAS</span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </aside>

      <main class="main">
        <div class="note-header">
          <span class="note-path">
            {view() === "graph" ? "🕸 Graph view" : view() === "canvas" ? `🧩 ${canvasPath() ?? ""}` : current() ?? ""}
          </span>
          <Show when={view() === "editor" && current()}>
            <button title="Đổi tên / di chuyển" onClick={renameCurrent}>✎</button>
            <button title="Chuyển vào thùng rác" onClick={trashCurrent}>🗑</button>
          </Show>
        </div>
        <div
          class="editor-host"
          ref={editorHost}
          style={{ display: view() === "editor" && current() ? "block" : "none" }}
        />
        <Show when={view() === "editor" && !current()}>
          <div class="empty-state">
            <h2>Second Brain</h2>
            <p>
              {root()
                ? "Chọn note bên trái, hoặc Ctrl+K để tìm / tạo."
                : "Bấm 🗂 để mở một vault (thư mục chứa file .md)."}
            </p>
            <p class="hint">
              Ctrl+K tìm/tạo · ? hỏi đáp · Ctrl+G graph · 📅 daily note · [[ autocomplete · Ctrl+Click mở link
            </p>
          </div>
        </Show>
        <Show when={view() === "graph"}>
          <GraphView onOpen={openNote} />
        </Show>
        <Show when={view() === "canvas" && canvasPath()} keyed>
          {(p) => (
            <CanvasView
              path={p as string}
              onOpenNote={openNote}
              requestNotePick={(cb) =>
                setPromptCfg({
                  title: "Đường dẫn note cần thêm vào canvas (vd: Tech/Rust.md)",
                  value: "",
                  onOk: (v) => v.trim() && cb(v.trim()),
                })
              }
            />
          )}
        </Show>
      </main>

      <aside class="rightbar">
        <div class="panel-title">Backlinks ({backlinks().length})</div>
        <For each={backlinks()}>
          {(b) => (
            <div class="backlink" onClick={() => openNote(b.src_path)} title={b.src_path}>
              <div class="backlink-title">{b.src_title}</div>
              <div class="backlink-path">{b.src_path}</div>
            </div>
          )}
        </For>
        <Show when={current() && backlinks().length === 0}>
          <div class="tree-empty">Chưa có note nào link tới đây</div>
        </Show>

        <Show when={mentions().length > 0}>
          <div class="panel-title">Nhắc tới chưa link ({mentions().length})</div>
          <For each={mentions()}>
            {(m) => (
              <div class="backlink" onClick={() => openNote(m.path)} title={m.path}>
                <div class="backlink-title">{m.title}</div>
                <div class="backlink-path">{m.snippet.replace(/[»«]/g, "")}</div>
              </div>
            )}
          </For>
        </Show>

        <Show when={related().length > 0}>
          <div class="panel-title">Liên quan</div>
          <For each={related()}>
            {(r) => (
              <div class="backlink" onClick={() => openNote(r.path)} title={r.path}>
                <div class="backlink-title">{r.title}</div>
                <div class="backlink-path">{r.heading_path || r.path}</div>
              </div>
            )}
          </For>
        </Show>
      </aside>

      <footer class="statusbar">
        <span>{status()}</span>
        <span class="spacer" />
        <Show when={janitorBadge()}>
          <span
            class="janitor-badge"
            onClick={() => {
              setJanitorBadge(false);
              setJanitorOpen(true);
            }}
          >
            🧹 báo cáo mới
          </span>
        </Show>
        <Show when={semStatus()}>
          <span class="sem-status">{semStatus()}</span>
        </Show>
        <Show when={stats()}>
          <span>
            {stats()!.notes} notes · {stats()!.links} links
            <Show when={stats()!.broken > 0}>
              <span class="broken"> · {stats()!.broken} gãy</span>
            </Show>
          </span>
        </Show>
      </footer>

      <Show when={omniOpen()}>
        <div class="overlay" onClick={() => setOmniOpen(false)}>
          <div class="omnibar" onClick={(e) => e.stopPropagation()}>
            <input
              ref={omniInput}
              placeholder="Tìm note hoặc nội dung… (bắt đầu bằng ? để hỏi đáp)"
              value={omniQuery()}
              onInput={(e) => setOmniQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (isAskMode()) {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    doAsk();
                  }
                  return;
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setOmniSel((s) => Math.min(s + 1, omniItems().length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setOmniSel((s) => Math.max(s - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  omniPick(omniSel());
                }
              }}
            />
            <Show when={!isAskMode()}>
              <div class="omni-results">
                <For each={omniItems()}>
                  {(item, i) => (
                    <div
                      class="omni-item"
                      classList={{ selected: i() === omniSel() }}
                      onMouseEnter={() => setOmniSel(i())}
                      onClick={() => omniPick(i())}
                    >
                      <div class="omni-label">{item.label}</div>
                      <div class="omni-sub">{item.sub}</div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={isAskMode()}>
              <div class="ask-panel">
                <Show when={!answer() && !asking()}>
                  <div class="ask-hint">
                    Enter để hỏi — Claude sẽ suy luận, tìm trong vault và trả lời kèm nguồn.
                  </div>
                </Show>
                <Show when={asking()}>
                  <div class="ask-hint">Đang suy luận & tìm kiếm… (vài chục giây)</div>
                </Show>
                <Show when={answer()}>
                  <div class="ask-answer">
                    <For each={answerParts()}>
                      {(part) =>
                        part.target ? (
                          <a class="ask-link" onClick={() => openWiki(part.target!)}>
                            {part.text}
                          </a>
                        ) : (
                          <span>{part.text}</span>
                        )
                      }
                    </For>
                  </div>
                  <Show when={answer()!.sources.length > 0}>
                    <div class="ask-sources">
                      <span class="ask-provider">via {answer()!.provider} · nguồn:</span>
                      <For each={[...new Set(answer()!.sources.map((s) => s.path))]}>
                        {(p) => (
                          <a class="ask-link" onClick={() => { setOmniOpen(false); openNote(p); }}>
                            {p}
                          </a>
                        )}
                      </For>
                      <button class="ask-save" onClick={saveAnswerAsNote}>
                        Lưu thành note
                      </button>
                    </div>
                  </Show>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={settingsOpen()}>
        <div class="overlay" onClick={() => setSettingsOpen(false)}>
          <div class="prompt-modal settings-modal" onClick={(e) => e.stopPropagation()}>
            <div class="prompt-title">Settings — LLM cho hỏi đáp & reasoning search</div>
            <div class="settings-body">
              <For
                each={[
                  { v: "auto", label: "Tự động (ưu tiên Claude)" },
                  { v: "claude", label: "Claude Code CLI" },
                  { v: "codex", label: "Codex CLI" },
                ]}
              >
                {(opt) => (
                  <label
                    class="settings-option"
                    classList={{
                      disabled:
                        (opt.v === "claude" && llm() ? !llm()!.claude_ok : false) ||
                        (opt.v === "codex" && llm() ? !llm()!.codex_ok : false),
                    }}
                  >
                    <input
                      type="radio"
                      name="llm"
                      checked={llm()?.pref === opt.v || (!llm()?.pref && opt.v === "auto")}
                      onChange={() => choosePref(opt.v)}
                    />
                    <span>{opt.label}</span>
                    <span class="settings-state">
                      {opt.v === "claude" && (llm()?.claude_ok ? "✓ có sẵn" : "✗ không thấy trên PATH")}
                      {opt.v === "codex" && (llm()?.codex_ok ? "✓ có sẵn" : "✗ không thấy trên PATH")}
                    </span>
                  </label>
                )}
              </For>
              <div class="settings-active">
                Đang dùng: <b>{llm()?.active ?? "không có provider nào"}</b>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={janitorOpen()}>
        <div class="overlay" onClick={() => setJanitorOpen(false)}>
          <div class="prompt-modal janitor-modal" onClick={(e) => e.stopPropagation()}>
            <div class="prompt-title">
              🧹 Janitor
              <Show when={janitorReport()}>
                {" — snapshot: "}
                {janitorReport()!.snapshotted ? "✓ git" : "✗ (cài git để an toàn hơn)"}
              </Show>
            </div>
            <div class="janitor-body">
              <Show when={janitorBusy()}>
                <div class="ask-hint">Đang lint vault…</div>
              </Show>
              <Show when={!janitorBusy() && janitorReport()}>
                <Show when={janitorReport()!.applied.length > 0}>
                  <div class="panel-title">Đã tự sửa</div>
                  <For each={janitorReport()!.applied}>
                    {(a) => <div class="jan-item jan-ok">✓ {a.description}</div>}
                  </For>
                </Show>
                <Show when={janitorReport()!.proposals.length > 0}>
                  <div class="panel-title">Đề xuất — cần bạn duyệt</div>
                  <For each={janitorReport()!.proposals}>
                    {(p) => (
                      <div class="jan-item">
                        <span>{p.description}</span>
                        <span class="jan-actions">
                          <button class="ask-save" onClick={() => janitorAct(p.id, true)}>
                            Áp dụng
                          </button>
                          <button class="jan-dismiss" onClick={() => janitorAct(p.id, false)}>
                            Bỏ qua
                          </button>
                        </span>
                      </div>
                    )}
                  </For>
                </Show>
                <Show when={janitorReport()!.suggestions.length > 0}>
                  <div class="panel-title">Gợi ý</div>
                  <For each={janitorReport()!.suggestions}>
                    {(s) => <div class="jan-item jan-dim">· {s.description}</div>}
                  </For>
                </Show>
                <Show
                  when={
                    janitorReport()!.applied.length +
                      janitorReport()!.proposals.length +
                      janitorReport()!.suggestions.length ===
                    0
                  }
                >
                  <div class="ask-hint">Vault sạch sẽ, không có gì để làm 🎉</div>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={promptCfg()}>
        <div class="overlay" onClick={() => setPromptCfg(null)}>
          <div class="prompt-modal" onClick={(e) => e.stopPropagation()}>
            <div class="prompt-title">{promptCfg()!.title}</div>
            <input
              autofocus
              value={promptCfg()!.value}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const cfg = promptCfg()!;
                  setPromptCfg(null);
                  cfg.onOk(e.currentTarget.value);
                }
              }}
            />
            <div class="prompt-hint">Enter để xác nhận · Esc để hủy</div>
          </div>
        </div>
      </Show>
    </div>
  );
}
