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
  type RevisionMeta,
  type SearchHit,
  type Stats,
} from "./api";
import { CanvasView } from "./canvas";
import { ChatPanel } from "./chat";
import { createEditor, type EditorHandle } from "./editor";
import { GraphView } from "./graph";
import { TermPanel } from "./terminal";
import { Tree, type TreeEditing } from "./tree";

type View = "editor" | "graph" | "canvas";

/** Một tab của khu vực chính: note, graph, canvas hoặc trống ("New tab"). */
interface TabState {
  id: number;
  kind: "empty" | "note" | "graph" | "canvas";
  /** note: path .md · canvas: path .canvas · graph: giữ path cũ để toggle quay lại. */
  path: string | null;
}

export default function App() {
  const [root, setRoot] = createSignal<string | null>(null);
  const [notes, setNotes] = createSignal<NoteMeta[]>([]);
  const [dirs, setDirs] = createSignal<string[]>([]);
  // Note/folder vừa tạo đang chờ đặt tên inline trong tree.
  const [treeEditing, setTreeEditing] = createSignal<TreeEditing | null>(null);
  const [stats, setStats] = createSignal<Stats | null>(null);
  const [current, setCurrent] = createSignal<string | null>(null);
  const [backlinks, setBacklinks] = createSignal<Backlink[]>([]);
  const [related, setRelated] = createSignal<RelatedNote[]>([]);
  const [mentions, setMentions] = createSignal<SearchHit[]>([]);
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

  // View chính: editor / graph / canvas (phản ánh tab đang active)
  const [view, setView] = createSignal<View>("editor");
  const [canvasPath, setCanvasPath] = createSignal<string | null>(null);
  const [canvases, setCanvases] = createSignal<string[]>([]);

  // Tabs: mở nhiều note/graph/canvas song song, mỗi tab một trạng thái riêng.
  const [tabs, setTabs] = createSignal<TabState[]>([{ id: 1, kind: "empty", path: null }]);
  const [activeId, setActiveId] = createSignal(1);
  let nextTabId = 2;

  // Settings + Janitor
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [llm, setLlm] = createSignal<LlmSettings | null>(null);
  const [janitorOpen, setJanitorOpen] = createSignal(false);
  const [janitorReport, setJanitorReport] = createSignal<JanitorReport | null>(null);
  const [janitorBusy, setJanitorBusy] = createSignal(false);
  const [janitorBadge, setJanitorBadge] = createSignal(false);

  // Revision history (🕘) của note đang mở
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [revs, setRevs] = createSignal<RevisionMeta[]>([]);
  const [revSel, setRevSel] = createSignal<number | null>(null);
  const [revContent, setRevContent] = createSignal("");

  // Agent chat sidebar + terminal panel + git sync + panel phải (backlinks)
  const [chatOpen, setChatOpen] = createSignal(localStorage.getItem("chatOpen") === "1");
  const [rightOpen, setRightOpen] = createSignal(localStorage.getItem("rightOpen") !== "0");
  const [termVisible, setTermVisible] = createSignal(false);
  const [syncBusy, setSyncBusy] = createSignal(false);

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
  // H1 của note lúc mở/lưu lần cuối — chỉ auto-rename file khi CHÍNH H1 bị sửa
  // trong phiên này (mở note cũ có H1 lệch tên file thì không tự ý đổi).
  let lastH1: string | null = null;

  const extractH1 = (content: string) => {
    const m = content.match(/^#[ \t]+(.+?)\s*$/m);
    return m ? m[1].trim() : null;
  };

  const sanitizeName = (s: string) =>
    s.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

  /** H1 đổi → đổi tên file theo (giữ thư mục, link trỏ tới tự rewrite). */
  const renameToH1 = async (h1: string) => {
    const from = currentPath;
    if (!from) return;
    const clean = sanitizeName(h1);
    if (!clean) return;
    const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
    const stem = from.split("/").pop()!.replace(/\.md$/i, "");
    if (stem.toLowerCase() === clean.toLowerCase()) return;
    const to = `${dir}${clean}.md`;
    // Đã có note khác trùng tên → thôi, không đổi (user chỉnh H1 tiếp sẽ thử lại).
    if (notes().some((n) => n.path.toLowerCase() === to.toLowerCase())) return;
    try {
      await api.renameNote(from, to);
      applyInfo(await api.refresh());
      retargetTabs(from, to);
      currentPath = to;
      setCurrent(to);
      loadPanels(to);
      say(`Tên file theo H1: ${clean}.md`);
    } catch {
      // rename fail (tên không hợp lệ trên fs…) → giữ tên cũ, không phiền user
    }
  };

  const say = (msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus((s) => (s === msg ? "" : s)), 4000);
  };

  const applyInfo = (info: { root: string; notes: NoteMeta[]; dirs: string[]; stats: Stats }) => {
    setRoot(info.root);
    setNotes(info.notes);
    setDirs(info.dirs ?? []);
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

  const activeTab = () => tabs().find((t) => t.id === activeId()) ?? tabs()[0];
  const updateTab = (id: number, patch: Partial<TabState>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const openNote = async (path: string) => {
    if (currentPath) editor.flush();
    try {
      const content = await api.readNote(path);
      currentPath = path;
      lastH1 = extractH1(content);
      setCurrent(path);
      setView("editor");
      editor.setContent(content);
      loadPanels(path);
      updateTab(activeId(), { kind: "note", path });
    } catch (e) {
      say(String(e));
    }
  };

  const openCanvas = (path: string) => {
    if (currentPath) editor.flush();
    currentPath = null;
    setCurrent(null);
    setCanvasPath(path);
    setView("canvas");
    updateTab(activeId(), { kind: "canvas", path });
  };

  /** Đồng bộ khu vực chính (editor/graph/canvas) theo nội dung một tab. */
  const applyTab = async (t: TabState) => {
    currentPath = null;
    if (t.kind === "note" && t.path) {
      try {
        const content = await api.readNote(t.path);
        currentPath = t.path;
        lastH1 = extractH1(content);
        setCurrent(t.path);
        setView("editor");
        editor.setContent(content);
        loadPanels(t.path);
        return;
      } catch (e) {
        say(String(e));
      }
    }
    setCurrent(null);
    if (t.kind === "canvas" && t.path) {
      setCanvasPath(t.path);
      setView("canvas");
    } else if (t.kind === "graph") {
      setView("graph");
    } else {
      setView("editor");
      editor.setContent("");
    }
  };

  const switchTab = async (id: number) => {
    if (id === activeId()) return;
    const t = tabs().find((x) => x.id === id);
    if (!t) return;
    if (currentPath) editor.flush();
    setActiveId(id);
    await applyTab(t);
  };

  const newTab = () => {
    if (currentPath) editor.flush();
    const t: TabState = { id: nextTabId++, kind: "empty", path: null };
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
    currentPath = null;
    setCurrent(null);
    setView("editor");
    editor.setContent("");
  };

  const openNoteInNewTab = async (path: string) => {
    const t: TabState = { id: nextTabId++, kind: "empty", path: null };
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
    await openNote(path);
  };

  const closeTab = async (id: number) => {
    const ts = tabs();
    const idx = ts.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const wasActive = id === activeId();
    if (wasActive && currentPath) editor.flush();
    let rest = ts.filter((t) => t.id !== id);
    if (rest.length === 0) rest = [{ id: nextTabId++, kind: "empty", path: null }];
    setTabs(rest);
    if (wasActive) {
      const next = rest[Math.min(idx, rest.length - 1)];
      setActiveId(next.id);
      await applyTab(next);
    }
  };

  /** Bật/tắt graph trên tab hiện tại; tắt thì quay về nội dung cũ của tab. */
  const toggleGraph = async () => {
    const t = activeTab();
    if (t.kind !== "graph") {
      if (currentPath) editor.flush();
      currentPath = null;
      setCurrent(null);
      setView("graph");
      updateTab(t.id, { kind: "graph" });
    } else {
      const kind = !t.path
        ? "empty"
        : t.path.toLowerCase().endsWith(".canvas")
          ? "canvas"
          : "note";
      updateTab(t.id, { kind });
      await applyTab({ ...t, kind });
    }
  };

  const tabTitle = (t: TabState) =>
    t.kind === "graph"
      ? "🕸 Graph"
      : t.kind === "canvas"
        ? `🧩 ${(t.path ?? "").replace(/\.canvas$/i, "")}`
        : t.path
          ? t.path.split("/").pop()!.replace(/\.md$/i, "")
          : "New tab";

  /** Note đổi path (rename) hoặc biến mất (to=null) → cập nhật mọi tab đang trỏ tới. */
  const retargetTabs = (from: string, to: string | null) =>
    setTabs((ts) =>
      ts.map((t) =>
        t.path === from ? { ...t, path: to, kind: to ? t.kind : "empty" } : t,
      ),
    );

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
        applyInfo(await api.refresh());
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
      // H1 vừa bị sửa trong lần lưu này → đồng bộ tên file theo H1.
      const h1 = extractH1(content);
      if (h1 !== lastH1) {
        lastH1 = h1;
        if (h1) await renameToH1(h1);
      }
    } catch (e) {
      say(String(e));
    }
  };

  /** Tên "Untitled", "Untitled 1", … chưa bị chiếm trong `taken` (so sánh không phân biệt hoa thường). */
  const untitledName = (taken: Set<string>) => {
    let name = "Untitled";
    for (let i = 1; taken.has(name.toLowerCase()); i++) name = `Untitled ${i}`;
    return name;
  };

  /** Tạo note ngay với tên Untitled rồi cho đặt tên inline trong tree — không popup. */
  const newNote = async () => {
    if (treeEditing()) return;
    const taken = new Set(
      notes()
        .filter((n) => !n.path.includes("/"))
        .map((n) => n.path.toLowerCase().replace(/\.md$/i, "")),
    );
    try {
      const rel = await api.createNote(untitledName(taken));
      applyInfo(await api.refresh());
      await openNote(rel);
      setTreeEditing({ path: rel, kind: "note" });
    } catch (e) {
      say(String(e));
    }
  };

  /** Tạo folder ngay ở gốc vault với tên Untitled rồi cho đặt tên inline. */
  const newFolder = async () => {
    if (treeEditing()) return;
    const taken = new Set(
      dirs().filter((d) => !d.includes("/")).map((d) => d.toLowerCase()),
    );
    try {
      const rel = await api.createFolder(untitledName(taken));
      applyInfo(await api.refresh());
      setTreeEditing({ path: rel, kind: "dir" });
    } catch (e) {
      say(String(e));
    }
  };

  /** Xác nhận tên từ ô rename inline: đổi tên nếu khác, giữ nguyên nếu rỗng/không đổi. */
  const finishTreeRename = async (name: string) => {
    const ed = treeEditing();
    setTreeEditing(null);
    if (!ed) return;
    const clean = name.trim().replace(/[\\/]/g, "");
    const base = ed.path.split("/").pop()!.replace(/\.md$/i, "");
    if (!clean || clean === base) return;
    const dir = ed.path.includes("/") ? ed.path.slice(0, ed.path.lastIndexOf("/") + 1) : "";
    try {
      if (ed.kind === "note") {
        const to = `${dir}${clean}.md`;
        editor.flush();
        await api.renameNote(ed.path, to);
        applyInfo(await api.refresh());
        retargetTabs(ed.path, to);
        currentPath = null;
        await openNote(to);
      } else {
        await api.renameFolder(ed.path, dir + clean);
        applyInfo(await api.refresh());
      }
    } catch (e) {
      say(String(e)); // đổi tên fail (vd trùng tên) → item vẫn giữ tên Untitled
    }
  };

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
          const newPath = (to.trim().toLowerCase().endsWith(".md") ? to.trim() : to.trim() + ".md").replace(/\\/g, "/");
          retargetTabs(from, newPath);
          currentPath = null;
          await openNote(newPath);
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
          retargetTabs(path, null);
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

  const toggleChat = () => {
    const v = !chatOpen();
    setChatOpen(v);
    localStorage.setItem("chatOpen", v ? "1" : "0");
  };

  const toggleRight = () => {
    const v = !rightOpen();
    setRightOpen(v);
    localStorage.setItem("rightOpen", v ? "1" : "0");
  };

  /** Sync GitHub một chạm: add → commit → push (git CLI chạy trong vault). */
  const gitSync = async () => {
    if (syncBusy()) return;
    setSyncBusy(true);
    say("Đang sync GitHub…");
    try {
      say(await api.gitSync());
    } catch (e) {
      say(String(e));
    } finally {
      setSyncBusy(false);
    }
  };

  /** Agent vừa sửa vault xong: re-index, reload note đang mở nếu nội dung đổi trên đĩa.
   *  Dùng updateContent để GIỮ undo history → Ctrl+Z revert được thay đổi của agent. */
  const vaultChanged = async () => {
    try {
      applyInfo(await api.refresh());
      setCanvases(await api.listCanvases().catch(() => []));
      const p = currentPath;
      if (p) {
        const content = await api.readNote(p);
        editor.updateContent(content);
        loadPanels(p);
      }
    } catch (e) {
      say(String(e));
    }
  };

  /** Mở modal 🕘 lịch sử phiên bản của note đang mở. */
  const openHistory = async () => {
    const p = current();
    if (!p) return;
    setHistoryOpen(true);
    setRevSel(null);
    setRevContent("");
    try {
      setRevs(await api.noteHistory(p));
    } catch (e) {
      say(String(e));
      setRevs([]);
    }
  };

  const pickRev = async (id: number) => {
    setRevSel(id);
    try {
      setRevContent(await api.historyGet(id));
    } catch (e) {
      setRevContent(String(e));
    }
  };

  /** Khôi phục revision: áp vào editor dạng transaction (Ctrl+Z quay lại được) + lưu. */
  const restoreRev = async () => {
    const p = current();
    const id = revSel();
    if (!p || id == null) return;
    try {
      const content = await api.historyGet(id);
      editor.updateContent(content);
      await api.writeNote(p, content);
      applyInfo(await api.refresh());
      loadPanels(p);
      setHistoryOpen(false);
      say("Đã khôi phục phiên bản cũ (Ctrl+Z để quay lại bản trước đó)");
    } catch (e) {
      say(String(e));
    }
  };

  const fmtTs = (ts: number) => {
    const d = new Date(ts * 1000);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    return sameDay ? `${time} hôm nay` : `${time} · ${d.toLocaleDateString("vi-VN")}`;
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
        toggleGraph();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        editor.flush();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newNote();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") {
        e.preventDefault();
        newTab();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        closeTab(activeId());
      } else if ((e.ctrlKey || e.metaKey) && e.key === "`") {
        e.preventDefault();
        setTermVisible((v) => !v);
      } else if (e.key === "Escape") {
        setOmniOpen(false);
        setPromptCfg(null);
        setSettingsOpen(false);
        setJanitorOpen(false);
        setHistoryOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      editor.destroy();
    });
  });

  return (
    <div class="app" classList={{ "chat-open": chatOpen(), "right-closed": !rightOpen() }}>
      <nav class="ribbon">
        <button title="Tìm hoặc tạo note (Ctrl+K / Ctrl+O)" onClick={() => { setOmniOpen(true); setOmniQuery(""); setAnswer(null); queueMicrotask(() => omniInput?.focus()); }}>🔍</button>
        <button title="Hỏi đáp vault" onClick={() => { setOmniOpen(true); setOmniQuery("? "); setAnswer(null); queueMicrotask(() => omniInput?.focus()); }}>💬</button>
        <button title="Graph view (Ctrl+G)" classList={{ active: view() === "graph" }} onClick={toggleGraph}>🕸</button>
        <button title="Daily note hôm nay" onClick={openDaily}>📅</button>
        <button title="Canvas mới" onClick={newCanvas}>🧩</button>
        <button title="Janitor: lint & dọn dẹp" onClick={runJanitor}>🧹</button>
        <button title="Sync GitHub: add → commit → push" disabled={syncBusy()} onClick={gitSync}>⇅</button>
        <button title="Chat với agent (sửa nội dung, format, cấu trúc vault)" classList={{ active: chatOpen() }} onClick={toggleChat}>🤖</button>
        <button title="Terminal chạy claude (Ctrl+`)" classList={{ active: termVisible() }} onClick={() => setTermVisible((v) => !v)}>🖥</button>
        <div class="ribbon-spacer" />
        <button title="Mở vault khác" onClick={pickVault}>🗂</button>
        <button title="Settings" onClick={openSettings}>⚙</button>
      </nav>

      <aside class="sidebar">
        <div class="sidebar-head">
          <button title="Note mới (Ctrl+N)" onClick={newNote}>＋</button>
          <button title="Folder mới" onClick={newFolder}>🗀</button>
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
        </div>
        <Show when={root()} fallback={<div class="tree-empty">Chưa mở vault</div>}>
          <div class="tree-scroll">
            <Tree
              notes={notes()}
              dirs={dirs()}
              filter={""}
              current={current()}
              editing={treeEditing()}
              onOpen={openNote}
              onOpenNewTab={openNoteInNewTab}
              onRename={finishTreeRename}
            />
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
        <div class="tabbar">
          <For each={tabs()}>
            {(t) => (
              <div
                class="tab"
                classList={{ active: t.id === activeId() }}
                onClick={() => switchTab(t.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
                title={t.path ?? "Tab trống"}
              >
                <span class="tab-label">{tabTitle(t)}</span>
                <button
                  class="tab-close"
                  title="Đóng tab (Ctrl+W)"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  ×
                </button>
              </div>
            )}
          </For>
          <button class="tab-add" title="Tab mới (Ctrl+T)" onClick={newTab}>＋</button>
          <div class="tabbar-spacer" />
          <button
            class="tab-add"
            title={rightOpen() ? "Đóng panel phải (backlinks)" : "Mở panel phải (backlinks)"}
            onClick={toggleRight}
          >
            {rightOpen() ? "◨" : "◧"}
          </button>
        </div>
        <div class="note-header">
          <span class="note-path">
            {view() === "graph" ? "🕸 Graph view" : view() === "canvas" ? `🧩 ${canvasPath() ?? ""}` : current() ?? ""}
          </span>
          <Show when={view() === "editor" && current()}>
            <button title="Lịch sử phiên bản (mọi thay đổi của bạn & AI)" onClick={openHistory}>🕘</button>
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
        <TermPanel visible={termVisible()} onClose={() => setTermVisible(false)} />
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

      <ChatPanel
        visible={chatOpen()}
        currentPath={current()}
        onVaultChanged={vaultChanged}
        onClose={toggleChat}
      />

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
                    <span class="settings-label">{opt.label}</span>
                    <span
                      class="settings-state"
                      classList={{
                        ok: (opt.v === "claude" && !!llm()?.claude_ok) || (opt.v === "codex" && !!llm()?.codex_ok),
                        missing:
                          (opt.v === "claude" && llm() != null && !llm()!.claude_ok) ||
                          (opt.v === "codex" && llm() != null && !llm()!.codex_ok),
                      }}
                    >
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

      <Show when={historyOpen()}>
        <div class="overlay" onClick={() => setHistoryOpen(false)}>
          <div class="prompt-modal history-modal" onClick={(e) => e.stopPropagation()}>
            <div class="prompt-title">🕘 Lịch sử phiên bản — {current()}</div>
            <div class="history-body">
              <Show
                when={revs().length > 0}
                fallback={
                  <div class="ask-hint">
                    Chưa có phiên bản cũ nào — revision được tạo khi note thay đổi (bạn sửa, AI sửa, hay tool ngoài).
                  </div>
                }
              >
                <div class="history-list">
                  <For each={revs()}>
                    {(r) => (
                      <div
                        class="history-item"
                        classList={{ selected: revSel() === r.id }}
                        onClick={() => pickRev(r.id)}
                      >
                        <div class="history-time">{fmtTs(r.ts)}</div>
                        <div class="history-meta">{r.chars} ký tự</div>
                      </div>
                    )}
                  </For>
                </div>
                <div class="history-preview">
                  <Show
                    when={revSel() != null}
                    fallback={<div class="ask-hint">Chọn một phiên bản để xem trước</div>}
                  >
                    <pre class="history-content">{revContent()}</pre>
                    <button class="ask-save" onClick={restoreRev}>
                      ↩ Khôi phục bản này
                    </button>
                  </Show>
                </div>
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
