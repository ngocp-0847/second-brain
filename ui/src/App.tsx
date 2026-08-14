import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  createEffect,
  createMemo,
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
import { ChatPanel, type ChatSelection } from "./chat";
import { createEditor, type EditorHandle, type SelectionInfo } from "./editor";
import { GraphView } from "./graph";
import {
  IconAdd,
  IconAgent,
  IconAi,
  IconAllClear,
  IconAsk,
  IconBack,
  IconBookmark,
  IconBullets,
  IconCanvas,
  IconClose,
  IconCopyPath,
  IconDaily,
  IconDark,
  IconDirArrow,
  IconDuplicate,
  IconForward,
  IconGraph,
  IconHistory,
  IconJanitor,
  IconLight,
  IconMove,
  IconNewFolder,
  IconNewNote,
  IconNewWindow,
  IconOk,
  IconOpenExternal,
  IconOpenNewTab,
  IconPanelClose,
  IconPanelOpen,
  IconPin,
  IconReindex,
  IconRename,
  IconRestore,
  IconReveal,
  IconSearch,
  IconSend,
  IconSettings,
  IconShorten,
  IconSpell,
  IconSync,
  IconSystemTheme,
  IconTable,
  IconTerminal,
  IconTranslate,
  IconTrash,
  IconTree,
  IconUnbookmark,
  IconVault,
} from "./icons";
import { ContextMenu, type MenuAnchor, type MenuItem } from "./menu";
import { TermPanel } from "./terminal";
import { DragGhost, setDirDropHandler } from "./dnd";
import { parentDir, Tree, type TreeEditing, type TreeFile } from "./tree";
import {
  forgetVault,
  getBookmarks,
  getWorkspace,
  initSession,
  pushRecentVault,
  recentVaults,
  saveBookmarks,
  saveWorkspace,
  type Bookmark,
  type PersistedTab,
} from "./session";
import { isDark, setThemePref, theme, themePref, toggleTheme, type ThemePref } from "./theme";

type View = "editor" | "graph" | "canvas";

/** `?note=` do `open_note_window` gắn vào URL: cửa sổ này chỉ để xem đúng một
 *  note, nên bỏ qua khôi phục phiên VÀ không được ghi đè workspace đã lưu. */
const SOLO_NOTE = new URLSearchParams(location.search).get("note");

/** Prompt sẵn cho "Sửa vùng chọn bằng AI" — bấm là chạy luôn. */
const SELECTION_ACTIONS = [
  { icon: IconTable, label: "Bảng markdown", prompt: "Format đoạn này thành table markdown" },
  { icon: IconShorten, label: "Viết gọn lại", prompt: "Viết lại đoạn này cho gọn và rõ hơn, giữ đủ ý" },
  { icon: IconBullets, label: "Bullet list", prompt: "Chuyển đoạn này thành danh sách gạch đầu dòng" },
  { icon: IconSpell, label: "Sửa chính tả", prompt: "Sửa chính tả và ngữ pháp, giữ nguyên cách diễn đạt" },
  { icon: IconTranslate, label: "Dịch EN", prompt: "Dịch đoạn này sang tiếng Anh tự nhiên" },
];

/** "3 phút trước", "2 ngày trước"… từ mtime (epoch giây). */
const fmtAgo = (epochSec: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSec);
  if (s < 60) return "vừa xong";
  const units: [number, string][] = [
    [60, "phút"],
    [3600, "giờ"],
    [86400, "ngày"],
    [86400 * 30, "tháng"],
  ];
  let out = "vừa xong";
  for (const [size, name] of units) {
    if (s >= size) out = `${Math.floor(s / size)} ${name} trước`;
  }
  return out;
};

/** Một chặng trong lịch sử điều hướng của tab (đủ để dựng lại nội dung tab). */
interface Loc {
  kind: "empty" | "note" | "graph" | "canvas";
  path: string | null;
}

/** Số chặng lịch sử giữ lại mỗi tab. */
const HIST_MAX = 50;

/** Một tab của khu vực chính: note, graph, canvas hoặc trống ("New tab"). */
interface TabState {
  id: number;
  kind: "empty" | "note" | "graph" | "canvas";
  /** note: path .md · canvas: path .canvas · graph: giữ path cũ để toggle quay lại. */
  path: string | null;
  /** Tab ghim: không bị "đóng các tab khác"/"đóng tất cả" cuốn theo. */
  pinned?: boolean;
  /** Lịch sử của RIÊNG tab này, kiểu trình duyệt. `hi` là vị trí hiện tại. */
  hist: Loc[];
  hi: number;
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
  const [tabs, setTabs] = createSignal<TabState[]>([
    { id: 1, kind: "empty", path: null, hist: [{ kind: "empty", path: null }], hi: 0 },
  ]);
  const [activeId, setActiveId] = createSignal(1);
  let nextTabId = 2;

  /** Tab trống mới, đã seed sẵn một chặng lịch sử. */
  const blankTab = (): TabState => ({
    id: nextTabId++,
    kind: "empty",
    path: null,
    hist: [{ kind: "empty", path: null }],
    hi: 0,
  });

  // Folder bị thu gọn trong tree + modal chuyển vault (🗂).
  const [closedDirs, setClosedDirs] = createSignal<Set<string>>(new Set());
  const [vaultOpen, setVaultOpen] = createSignal(false);
  // Chặn effect ghi workspace trong lúc đang khôi phục (tránh đè state vừa đọc lên).
  const [restoring, setRestoring] = createSignal(false);

  // Settings + Janitor
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [llm, setLlm] = createSignal<LlmSettings | null>(null);
  const [janitorOpen, setJanitorOpen] = createSignal(false);
  const [janitorReport, setJanitorReport] = createSignal<JanitorReport | null>(null);
  const [janitorBusy, setJanitorBusy] = createSignal(false);
  const [janitorBadge, setJanitorBadge] = createSignal(false);

  // Revision history (🕘) của note đang mở
  const [historyOpen, setHistoryOpen] = createSignal(false);
  /** Note mà modal 🕘 đang xem — có thể khác note đang mở (mở từ menu chuột phải). */
  const [histPath, setHistPath] = createSignal<string | null>(null);
  const [revs, setRevs] = createSignal<RevisionMeta[]>([]);
  const [revSel, setRevSel] = createSignal<number | null>(null);
  const [revContent, setRevContent] = createSignal("");

  // Agent chat sidebar + terminal panel + git sync + panel phải (backlinks)
  const [chatOpen, setChatOpen] = createSignal(localStorage.getItem("chatOpen") === "1");
  const [rightOpen, setRightOpen] = createSignal(localStorage.getItem("rightOpen") !== "0");
  const [termVisible, setTermVisible] = createSignal(false);
  const [syncBusy, setSyncBusy] = createSignal(false);

  // Vùng chọn trong editor → prompt AI sửa tại chỗ (popover) hoặc đẩy sang chat Agent.
  const [sel, setSel] = createSignal<SelectionInfo | null>(null);
  const [aiOpen, setAiOpen] = createSignal(false);
  const [aiPrompt, setAiPrompt] = createSignal("");
  const [aiBusy, setAiBusy] = createSignal(false);
  const [aiError, setAiError] = createSignal("");
  const [chatSel, setChatSel] = createSignal<ChatSelection | null>(null);
  let aiInput: HTMLInputElement | undefined;

  // Picker chọn note để gắn vào canvas: rỗng thì liệt kê note sửa gần đây, gõ thì lọc.
  // Hộp xác nhận hành động phá huỷ (xóa note/folder).
  const [confirmCfg, setConfirmCfg] = createSignal<{
    title: string;
    message: string;
    detail: string;
    confirmLabel: string;
    onOk: () => void;
  } | null>(null);
  const [dontAsk, setDontAsk] = createSignal(false);

  // Menu chuột phải + bookmark + hộp chọn folder khi "Di chuyển tới…"
  const [ctxMenu, setCtxMenu] = createSignal<MenuAnchor | null>(null);
  const [bookmarks, setBookmarks] = createSignal<Bookmark[]>([]);
  const [bmOpen, setBmOpen] = createSignal(true);
  const [folderPick, setFolderPick] = createSignal<{
    title: string;
    onOk: (dir: string) => void;
  } | null>(null);
  const [folderQuery, setFolderQuery] = createSignal("");

  const [notePick, setNotePick] = createSignal<((path: string) => void) | null>(null);
  const [pickQuery, setPickQuery] = createSignal("");
  const [pickSel, setPickSel] = createSignal(0);
  let pickInput: HTMLInputElement | undefined;

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
      // Người dùng có thể đã Back/Forward hoặc đổi tab trong lúc chờ rename —
      // đừng kéo họ về note cũ.
      if (currentPath !== from) return;
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

  // Chữ ký "những gì cây thư mục quan tâm". mtime đổi mỗi lần autosave nhưng
  // không ảnh hưởng cây, nên so bằng chữ ký này để khỏi dựng lại toàn bộ tree
  // (và mọi memo phụ thuộc) sau từng nhịp gõ.
  const treeSig = (ns: NoteMeta[], ds: string[]) =>
    `${ds.join(" ")}${ns.map((n) => `${n.path} ${n.title}`).join("")}`;
  let lastTreeSig = "";

  const applyInfo = (
    info: { root: string; notes: NoteMeta[]; dirs: string[]; stats: Stats },
    /** Bỏ qua guard chữ ký để lấy mtime mới nhất (dùng khi mở note picker). */
    force = false,
  ) => {
    setRoot(info.root);
    const nextDirs = info.dirs ?? [];
    const sig = treeSig(info.notes, nextDirs);
    if (force || sig !== lastTreeSig) {
      lastTreeSig = sig;
      setNotes(info.notes);
      setDirs(nextDirs);
    }
    setStats(info.stats);
  };

  const openVaultAt = async (path: string) => {
    setVaultOpen(false);
    // Bật trước setRoot: nếu không, effect ghi workspace sẽ chạy ngay khi root()
    // đổi — với tab của vault CŨ — và đè mất bản đã lưu của vault mới.
    setRestoring(true);
    try {
      const info = await api.openVault(path);
      applyInfo(info);
      await pushRecentVault(info.root);
      setBookmarks(getBookmarks(info.root));
      setCanvases(await api.listCanvases().catch(() => []));
      if (SOLO_NOTE) {
        // Cửa sổ rời: chỉ mở đúng file được yêu cầu, không đụng tới bộ tab
        // đã lưu của cửa sổ chính.
        await openByPath(SOLO_NOTE);
      } else {
        // Mỗi vault nhớ bộ tab riêng; chưa có gì đã lưu thì về tab trống.
        await restoreWorkspace(info.root);
      }
      say(`Đã mở vault (${stats()!.notes} notes, index ${stats()!.index_ms}ms)`);
    } catch (e) {
      // Vault đã biến mất (backend chặn ở open_vault) → giữ root() null, empty-state
      // sẽ hiện danh sách recent để chọn cái khác. Không xoá khỏi recent: ổ rời
      // cắm lại là dùng được.
      say(String(e));
    } finally {
      setRestoring(false);
    }
  };

  const pickVault = async () => {
    const dir = await openDialog({ directory: true, title: "Chọn thư mục vault" });
    if (typeof dir === "string") await openVaultAt(dir);
  };

  const toggleDir = (path: string, open: boolean) =>
    setClosedDirs((prev) => {
      if (open === !prev.has(path)) return prev; // không đổi → giữ nguyên tham chiếu
      const next = new Set(prev);
      if (open) next.delete(path);
      else next.add(path);
      return next;
    });

  /** Tên hiển thị của vault: đoạn cuối path. */
  const vaultName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

  /** Danh sách vault gần đây — dùng chung cho empty-state và modal 🗂. */
  const VaultList = () => (
    <div class="recent-vaults">
      <For each={recentVaults()}>
        {(p) => (
          <div
            class="recent-vault"
            classList={{ active: root() === p }}
            title={p}
            onClick={() => openVaultAt(p)}
          >
            <div class="recent-vault-text">
              <div class="recent-vault-name">{vaultName(p)}</div>
              <div class="recent-vault-path">{p}</div>
            </div>
            <button
              class="recent-vault-forget"
              title="Bỏ khỏi danh sách"
              onClick={(e) => {
                e.stopPropagation();
                void forgetVault(p);
              }}
            >
              <IconClose />
            </button>
          </div>
        )}
      </For>
    </div>
  );

  /** Vault chưa có workspace đã lưu: một tab trống, bung lại toàn bộ folder. */
  const resetWorkspace = () => {
    const id = nextTabId++;
    setTabs([{ id, kind: "empty", path: null, hist: [{ kind: "empty", path: null }], hi: 0 }]);
    setActiveId(id);
    setClosedDirs(new Set<string>());
    currentPath = null;
    setCurrent(null);
    setView("editor");
    editor.setContent("");
  };

  /** Dựng lại tab + trạng thái tree đã lưu cho vault này.
   *  Người gọi (openVaultAt) phải bật cờ restoring() TRƯỚC khi setRoot, nếu không
   *  effect ghi workspace sẽ chạy với tab của vault cũ và đè mất bản đã lưu. */
  const restoreWorkspace = async (vault: string) => {
    const ws = getWorkspace(vault);
    if (!ws?.tabs.length) {
      resetWorkspace();
      return;
    }
    {
      // Note/canvas có thể đã bị xoá ngoài app từ lần trước → bỏ tab mồ côi.
      const notePaths = new Set(notes().map((n) => n.path));
      const canvasPaths = new Set(canvases());
      const alive = ws.tabs.filter(
        (t) =>
          t.kind === "empty" ||
          t.kind === "graph" ||
          (t.kind === "note" && t.path && notePaths.has(t.path)) ||
          (t.kind === "canvas" && t.path && canvasPaths.has(t.path)),
      );
      if (!alive.length) {
        resetWorkspace();
        return;
      }
      // id là số runtime, không lưu xuống đĩa — cấp lại từ đầu. Lịch sử điều hướng
      // không persist (giống trình duyệt mở lại): mỗi tab bắt đầu từ đúng chặng của nó.
      const restored: TabState[] = alive.map((t) => ({
        id: nextTabId++,
        ...t,
        hist: [{ kind: t.kind, path: t.path }],
        hi: 0,
      }));
      const idx = Math.min(Math.max(ws.activeIndex, 0), restored.length - 1);
      setTabs(restored);
      setActiveId(restored[idx].id);
      setClosedDirs(new Set(ws.closedDirs ?? []));
      await applyTab(restored[idx]);
    }
  };

  const loadPanels = async (path: string) => {
    if (panelTimer) clearTimeout(panelTimer); // huỷ lượt debounce đang chờ
    setBacklinks(await api.backlinks(path).catch(() => []));
    setMentions(await api.unlinkedMentions(path).catch(() => []));
    setRelated(await api.relatedNotes(path).catch(() => []));
  };

  /** Nạp panel phải sau khi ngừng gõ — cả 3 query đều thuần SQL nên rẻ. */
  let panelTimer: ReturnType<typeof setTimeout> | undefined;
  const schedulePanels = (path: string) => {
    if (panelTimer) clearTimeout(panelTimer);
    panelTimer = setTimeout(() => {
      if (currentPath === path) void loadPanels(path);
    }, 300);
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
      pushHist({ kind: "note", path });
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
    pushHist({ kind: "canvas", path });
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

  // ---- lịch sử điều hướng của từng tab (kiểu trình duyệt) ----

  /** Bật khi đang đi Back/Forward: chặng đó đã có sẵn, đừng đẩy lại vào lịch sử. */
  let navigating = false;

  /** Ghi một chặng mới cho tab đang mở, cắt bỏ nhánh "forward" như trình duyệt. */
  const pushHist = (loc: Loc) => {
    if (navigating) return;
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== activeId()) return t;
        const cur = t.hist[t.hi];
        if (cur && cur.kind === loc.kind && cur.path === loc.path) return t;
        const hist = [...t.hist.slice(0, t.hi + 1), loc].slice(-HIST_MAX);
        return { ...t, hist, hi: hist.length - 1 };
      }),
    );
  };

  const canBack = () => (activeTab()?.hi ?? 0) > 0;
  const canForward = () => {
    const t = activeTab();
    return !!t && t.hi < t.hist.length - 1;
  };

  const go = async (delta: number) => {
    const t = activeTab();
    if (!t) return;
    const next = t.hi + delta;
    if (next < 0 || next >= t.hist.length) return;
    const loc = t.hist[next];
    if (currentPath) editor.flush();
    navigating = true;
    try {
      // Phải ghi cả kind/path chứ không riêng hi: tab state và khung nhìn mà lệch
      // nhau thì lần switchTab sau sẽ dựng lại đúng nội dung CŨ.
      updateTab(t.id, { ...loc, hi: next });
      await applyTab({ ...t, ...loc, hi: next });
    } finally {
      navigating = false;
    }
  };

  // ---- đóng tab hàng loạt ----

  /** Tab ghim được giữ lại; đóng hết mà không còn gì thì mở một tab trống. */
  const closeMany = async (keep: (t: TabState) => boolean) => {
    if (currentPath) editor.flush();
    let rest = tabs().filter((t) => t.pinned || keep(t));
    if (!rest.length) rest = [blankTab()];
    setTabs(rest);
    if (!rest.some((t) => t.id === activeId())) {
      setActiveId(rest[0].id);
      await applyTab(rest[0]);
    }
  };

  const closeOtherTabs = (id: number) => closeMany((t) => t.id === id);
  const closeAllTabs = () => closeMany(() => false);

  const togglePin = (id: number) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)));

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
    const t = blankTab();
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
    currentPath = null;
    setCurrent(null);
    setView("editor");
    editor.setContent("");
  };

  const openNoteInNewTab = async (path: string) => {
    const t = blankTab();
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
    if (rest.length === 0) rest = [blankTab()];
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
      pushHist({ kind: "graph", path: t.path });
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
      ? "Graph"
      : t.kind === "canvas"
        ? (t.path ?? "").replace(/\.canvas$/i, "")
        : t.path
          ? t.path.split("/").pop()!.replace(/\.md$/i, "")
          : "New tab";

  /** Icon đứng trước nhãn tab, phân biệt loại view. */
  const TabIcon = (p: { kind: TabState["kind"] }) => (
    <Show when={p.kind === "graph"} fallback={<Show when={p.kind === "canvas"}><IconCanvas /></Show>}>
      <IconGraph />
    </Show>
  );

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

  /** Tạo canvas rỗng "Untitled" rồi mở luôn, không hỏi tên — giống Obsidian.
   *  Đổi tên sau bằng nút đổi tên, đỡ chặn luồng khi đang cần vẽ nhanh. */
  const newCanvas = async () => {
    const taken = new Set(
      canvases()
        .filter((c) => !c.includes("/"))
        .map((c) => c.toLowerCase().replace(/\.canvas$/i, "")),
    );
    const path = `${untitledName(taken)}.canvas`;
    try {
      await api.writeNote(path, JSON.stringify({ nodes: [], edges: [] }));
      setCanvases(await api.listCanvases().catch(() => []));
      openCanvas(path);
    } catch (e) {
      say(String(e));
    }
  };

  const openNotePicker = (cb: (path: string) => void) => {
    setPickQuery("");
    setPickSel(0);
    setNotePick(() => cb); // bọc trong hàm: setSignal coi callback là updater
    queueMicrotask(() => pickInput?.focus());
    // applyInfo bỏ qua thay đổi chỉ-mtime để khỏi dựng lại tree khi gõ, nên ở
    // đây phải ép nạp lại thì thứ tự "sửa gần đây" mới đúng.
    void api.refresh().then((i) => applyInfo(i, true)).catch(() => {});
  };

  /** Rỗng → note sửa gần đây; có query → lọc theo tên và đường dẫn. */
  const pickHits = createMemo(() => {
    const q = pickQuery().trim().toLowerCase();
    const all = notes();
    if (!q) return [...all].sort((a, b) => b.mtime - a.mtime).slice(0, 40);
    return all
      .filter((n) => n.path.toLowerCase().includes(q) || n.title.toLowerCase().includes(q))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 40);
  });

  const confirmPick = () => {
    const hit = pickHits()[pickSel()];
    const cb = notePick();
    if (hit && cb) cb(hit.path);
    setNotePick(null);
  };

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
      // write_note đã index và trả VaultInfo — trước đây còn gọi thêm refresh(),
      // tức là quét toàn vault hai lần cho mỗi lần autosave.
      applyInfo(await api.writeNoteWithInfo(currentPath, content));
      setStatus("Đã lưu ✓");
      setTimeout(() => setStatus((s) => (s === "Đã lưu ✓" ? "" : s)), 1500);
      schedulePanels(currentPath);
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

  /** Con trực tiếp của `dir` ("" = gốc vault) trong một danh sách path phẳng. */
  const childrenOf = (paths: string[], dir: string) => {
    const prefix = dir ? `${dir}/` : "";
    return paths
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map((p) => p.slice(prefix.length));
  };

  /** Tạo note ngay với tên Untitled rồi cho đặt tên inline trong tree — không popup. */
  const newNoteIn = async (dir = "") => {
    if (treeEditing()) return;
    const taken = new Set(
      childrenOf(notes().map((n) => n.path), dir).map((n) =>
        n.toLowerCase().replace(/\.md$/i, ""),
      ),
    );
    const at = dir ? `${dir}/${untitledName(taken)}` : untitledName(taken);
    try {
      const rel = await api.createNote(at);
      applyInfo(await api.refresh());
      await openNote(rel);
      setTreeEditing({ path: rel, kind: "note" });
    } catch (e) {
      say(String(e));
    }
  };
  const newNote = () => newNoteIn();

  /** Tạo folder con của `dir` ("" = gốc vault) với tên Untitled rồi đặt tên inline. */
  const newFolderIn = async (dir = "") => {
    if (treeEditing()) return;
    const taken = new Set(childrenOf(dirs(), dir).map((d) => d.toLowerCase()));
    const at = dir ? `${dir}/${untitledName(taken)}` : untitledName(taken);
    try {
      const rel = await api.createFolder(at);
      applyInfo(await api.refresh());
      setTreeEditing({ path: rel, kind: "dir" });
    } catch (e) {
      say(String(e));
    }
  };
  const newFolder = () => newFolderIn();

  /** Xác nhận tên từ ô rename inline: đổi tên nếu khác, giữ nguyên nếu rỗng/không đổi. */
  const finishTreeRename = async (name: string) => {
    const ed = treeEditing();
    setTreeEditing(null);
    if (!ed) return;
    const clean = name.trim().replace(/[\\/]/g, "");
    const base = fileLabel(ed.path);
    if (!clean || clean === base) return;
    const dir = ed.path.includes("/") ? ed.path.slice(0, ed.path.lastIndexOf("/") + 1) : "";
    try {
      if (ed.kind === "note" && isCanvas(ed.path)) {
        // Canvas nằm chung cây với note nên cũng đổi tên inline, nhưng phải đi
        // qua rename_file: rename_note ép đuôi .md và tra bảng `note`.
        const to = await api.renameFile(ed.path, `${dir}${clean}`);
        setCanvases(await api.listCanvases().catch(() => []));
        retargetTabs(ed.path, to);
        void retargetBookmark(ed.path, to);
        if (canvasPath() === ed.path) openCanvas(to);
      } else if (ed.kind === "note") {
        const to = `${dir}${clean}.md`;
        editor.flush();
        await api.renameNote(ed.path, to);
        applyInfo(await api.refresh());
        retargetTabs(ed.path, to);
        void retargetBookmark(ed.path, to);
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
          void retargetBookmark(from, newPath);
          currentPath = null;
          await openNote(newPath);
          say(`Đã đổi tên, rewrite ${n} link trỏ tới`);
        } catch (e) {
          say(String(e));
        }
      },
    });
  };

  /** Hỏi trước khi làm, trừ khi user đã tick "Đừng hỏi lại". */
  const askConfirm = (
    cfg: { title: string; message: string; detail: string; confirmLabel: string },
    onOk: () => void,
  ) => {
    if (localStorage.getItem("skipDeleteConfirm") === "1") return onOk();
    setDontAsk(false);
    setConfirmCfg({ ...cfg, onOk });
  };

  /** Bấm nút xác nhận: nhớ lựa chọn "đừng hỏi lại" rồi mới chạy hành động. */
  const confirmNow = () => {
    const cfg = confirmCfg();
    if (!cfg) return;
    if (dontAsk()) localStorage.setItem("skipDeleteConfirm", "1");
    setConfirmCfg(null);
    cfg.onOk();
  };

  const trashNoteAt = (path: string) => {
    askConfirm(
      {
        title: isCanvas(path) ? "Xóa canvas" : "Xóa file",
        message: `Bạn có chắc muốn xóa "${path.split("/").pop()}"?`,
        detail: "File sẽ được chuyển vào thùng rác của vault (.brain/trash).",
        confirmLabel: "Xóa",
      },
      async () => {
        try {
          await api.trashNote(path);
          retargetTabs(path, null);
          void dropBookmark(path);
          if (isCanvas(path)) {
            setCanvases(await api.listCanvases().catch(() => []));
            if (canvasPath() === path) {
              setCanvasPath(null);
              setView("editor");
            }
          } else if (current() === path) {
            // Chỉ dọn editor khi xóa đúng note đang mở; xóa note khác giữ nguyên.
            currentPath = null;
            setCurrent(null);
            editor.setContent("");
          }
          applyInfo(await api.refresh());
          say("Đã chuyển vào thùng rác");
        } catch (e) {
          say(String(e));
        }
      },
    );
  };

  const trashCurrent = () => {
    const path = current();
    if (path) trashNoteAt(path);
  };

  const trashFolderAt = (path: string) => {
    const n = notes().filter((x) => x.path.startsWith(`${path}/`)).length;
    askConfirm(
      {
        title: "Xóa thư mục",
        message: `Bạn có chắc muốn xóa "${path}"?`,
        detail: `Cả thư mục${n ? ` và ${n} note bên trong` : ""} sẽ được chuyển vào thùng rác của vault (.brain/trash).`,
        confirmLabel: "Xóa",
      },
      async () => {
        try {
          await api.trashFolder(path);
          // Mọi note bên trong đi theo folder → tab và bookmark trỏ vào đó phải rụng.
          const inside = `${path}/`;
          for (const note of notes()) {
            if (note.path.startsWith(inside)) {
              retargetTabs(note.path, null);
              void dropBookmark(note.path);
            }
          }
          if (current()?.startsWith(inside)) {
            currentPath = null;
            setCurrent(null);
            editor.setContent("");
          }
          applyInfo(await api.refresh());
          say("Đã chuyển thư mục vào thùng rác");
        } catch (e) {
          say(String(e));
        }
      },
    );
  };

  // ---- Bookmark ----

  const isBookmarked = (path: string) => bookmarks().some((b) => b.path === path);

  const putBookmarks = async (list: Bookmark[]) => {
    setBookmarks(list);
    const v = root();
    if (v) await saveBookmarks(v, list);
  };

  const dropBookmark = (path: string) =>
    putBookmarks(bookmarks().filter((b) => b.path !== path));

  /** Note đổi tên/di chuyển → bookmark phải theo, nếu không sẽ trỏ vào hư không. */
  const retargetBookmark = (from: string, to: string) =>
    putBookmarks(bookmarks().map((b) => (b.path === from ? { ...b, path: to } : b)));

  const addBookmark = (path: string) => {
    setPromptCfg({
      title: "Tên hiển thị của bookmark",
      value: fileLabel(path),
      onOk: async (v) => {
        const title = v.trim() || fileLabel(path);
        await putBookmarks([...bookmarks().filter((b) => b.path !== path), { path, title }]);
      },
    });
  };

  // ---- Menu chuột phải ----

  /** Tên hiển thị của một path: bỏ thư mục và đuôi .md/.canvas. */
  const fileLabel = (p: string) => p.split("/").pop()!.replace(/\.(md|canvas)$/i, "");

  const isCanvas = (p: string) => /\.canvas$/i.test(p);

  /** Note + canvas trộn chung cho sidebar — canvas không nằm trong index nên
   *  phải ghép ở đây, nhưng KHÔNG đụng vào `notes()` (omnibar, autocomplete
   *  wikilink, graph… chỉ được thấy .md). */
  const treeFiles = createMemo<TreeFile[]>(() => [
    ...notes(),
    ...canvases().map((p) => ({ path: p, title: fileLabel(p), mtime: 0, canvas: true })),
  ]);

  /** Mở đúng loại view theo đuôi file (bookmark, cửa sổ rời, sau khi move…). */
  const openByPath = async (p: string) => (isCanvas(p) ? openCanvas(p) : await openNote(p));

  const openInNewTab = async (p: string) => {
    if (!isCanvas(p)) return openNoteInNewTab(p);
    const t = blankTab();
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
    openCanvas(p);
  };

  const copyText = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      say(`Đã copy ${what}`);
    } catch {
      // WebView không cho clipboard API (context không "secure") → cách cũ.
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      say(`Đã copy ${what}`);
    }
  };

  /** Mục "Copy path ▸" dùng chung cho note, folder và canvas. */
  const copyPathItem = (path: string): MenuItem => ({
    label: "Copy path",
    icon: IconCopyPath,
    submenu: [
      {
        label: "Đường dẫn trong vault",
        onSelect: () => void copyText(path, "đường dẫn"),
      },
      {
        label: "Đường dẫn tuyệt đối",
        onSelect: async () => {
          try {
            await copyText(await api.absPath(path), "đường dẫn tuyệt đối");
          } catch (e) {
            say(String(e));
          }
        },
      },
    ],
  });

  const osItems = (path: string): MenuItem[] => [
    {
      label: "Mở bằng app mặc định",
      icon: IconOpenExternal,
      onSelect: () => void api.openExternal(path).catch((e) => say(String(e))),
    },
    {
      label: "Hiện trong File Explorer",
      icon: IconReveal,
      onSelect: () => void api.revealInExplorer(path).catch((e) => say(String(e))),
    },
  ];

  /** Di chuyển file sang folder khác ("" = gốc vault). Note đi qua `renameNote`
   *  để wikilink được rewrite; canvas không nằm trong link graph nên `renameFile`. */
  const doMoveFile = async (path: string, dir: string) => {
    const name = path.split("/").pop()!;
    const to = dir ? `${dir}/${name}` : name;
    if (to === path) return;
    try {
      editor.flush();
      if (isCanvas(path)) {
        await api.renameFile(path, to);
        setCanvases(await api.listCanvases().catch(() => []));
        retargetTabs(path, to);
        if (canvasPath() === path) openCanvas(to);
        say("Đã di chuyển canvas");
      } else {
        const n = await api.renameNote(path, to);
        applyInfo(await api.refresh());
        retargetTabs(path, to);
        if (current() === path) {
          currentPath = null;
          await openNote(to);
        }
        say(`Đã di chuyển, rewrite ${n} link trỏ tới`);
      }
      void retargetBookmark(path, to);
    } catch (e) {
      say(String(e));
    }
  };

  // Thả file vào folder trong sidebar → cùng một đường với menu "Di chuyển tới…".
  // Thả về đúng folder cũ thì bỏ qua, khỏi tốn một lần rewrite link.
  setDirDropHandler((from, dir) => {
    if (parentDir(from) !== dir) void doMoveFile(from, dir);
  });

  const moveFileTo = (path: string) => {
    setFolderQuery("");
    setFolderPick({
      title: `Di chuyển "${fileLabel(path)}" tới…`,
      onOk: (dir) => void doMoveFile(path, dir),
    });
  };

  /** Đổi tên tại chỗ bằng ô inline trong tree — note và canvas như nhau.
   *  `finishTreeRename` tự chọn lệnh đúng theo đuôi file. */
  const renameFileAt = (path: string) => setTreeEditing({ path, kind: "note" });

  const duplicateFile = async (path: string) => {
    try {
      const rel = await api.duplicateNote(path);
      if (isCanvas(path)) {
        setCanvases(await api.listCanvases().catch(() => []));
        openCanvas(rel);
      } else {
        applyInfo(await api.refresh());
        await openNote(rel);
      }
      say(`Đã tạo bản sao: ${rel}`);
    } catch (e) {
      say(String(e));
    }
  };

  /** Phần thao tác trên FILE của menu — dùng chung cho sidebar và cho tab. */
  const fileActions = (path: string): MenuItem[] => [
    { label: "Nhân bản", icon: IconDuplicate, onSelect: () => void duplicateFile(path) },
    { label: "Di chuyển tới…", icon: IconMove, onSelect: () => moveFileTo(path) },
    isBookmarked(path)
      ? { label: "Bỏ bookmark", icon: IconUnbookmark, onSelect: () => void dropBookmark(path) }
      : { label: "Bookmark…", icon: IconBookmark, onSelect: () => addBookmark(path) },
    { separator: true, label: "" },
    copyPathItem(path),
    {
      label: "Lịch sử phiên bản",
      icon: IconHistory,
      onSelect: () => void openHistoryFor(path),
    },
    { separator: true, label: "" },
    ...osItems(path),
    { separator: true, label: "" },
    { label: "Đổi tên…", icon: IconRename, onSelect: () => renameFileAt(path) },
    { label: "Xóa", icon: IconTrash, danger: true, onSelect: () => trashNoteAt(path) },
  ];

  /** Menu cho một file trong vault — dùng chung cho note và canvas trong sidebar. */
  const fileMenu = (path: string): MenuItem[] => [
    { label: "Mở trong tab mới", icon: IconOpenNewTab, onSelect: () => void openInNewTab(path) },
    {
      label: "Mở trong cửa sổ mới",
      icon: IconNewWindow,
      onSelect: () => void api.openNoteWindow(path).catch((e) => say(String(e))),
    },
    { separator: true, label: "" },
    ...fileActions(path),
  ];

  /** Bung mọi folder cha rồi cuộn tới note trong sidebar ("Reveal file in navigation"). */
  const revealInTree = (path: string) => {
    const parts = path.split("/").slice(0, -1);
    const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    setClosedDirs((s) => {
      const next = new Set(s);
      for (const a of ancestors) next.delete(a);
      return next;
    });
    // Đợi <details> mở xong rồi mới cuộn, nếu không phần tử còn đang ẩn.
    setTimeout(() => {
      document
        .querySelector(`.tree-file[data-path="${CSS.escape(path)}"]`)
        ?.scrollIntoView({ block: "center" });
    }, 0);
  };

  /** Menu chuột phải trên một TAB: nhóm đóng/ghim, rồi thao tác file nếu tab có file. */
  const tabMenu = (t: TabState): MenuItem[] => {
    const items: MenuItem[] = [
      { label: "Đóng", icon: IconClose, onSelect: () => void closeTab(t.id) },
      { label: "Đóng các tab khác", onSelect: () => void closeOtherTabs(t.id) },
      { label: "Đóng tất cả", onSelect: () => void closeAllTabs() },
      { separator: true, label: "" },
      {
        label: t.pinned ? "Bỏ ghim" : "Ghim",
        icon: IconPin,
        onSelect: () => togglePin(t.id),
      },
    ];
    // Tab graph/trống không gắn với file nào — dừng ở nhóm trên.
    if (!t.path || t.kind === "graph") return items;
    items.push(
      {
        label: "Mở trong cửa sổ mới",
        icon: IconNewWindow,
        onSelect: () => void api.openNoteWindow(t.path!).catch((e) => say(String(e))),
      },
      { label: "Hiện trong sidebar", icon: IconTree, onSelect: () => revealInTree(t.path!) },
      { separator: true, label: "" },
      ...fileActions(t.path),
    );
    return items;
  };

  const dirMenu = (path: string): MenuItem[] => [
    { label: "Note mới ở đây", icon: IconNewNote, onSelect: () => void newNoteIn(path) },
    { label: "Folder con mới", icon: IconNewFolder, onSelect: () => void newFolderIn(path) },
    { separator: true, label: "" },
    copyPathItem(path),
    {
      label: "Hiện trong File Explorer",
      icon: IconReveal,
      onSelect: () => void api.revealInExplorer(path).catch((e) => say(String(e))),
    },
    { separator: true, label: "" },
    { label: "Đổi tên…", icon: IconRename, onSelect: () => setTreeEditing({ path, kind: "dir" }) },
    { label: "Xóa", icon: IconTrash, danger: true, onSelect: () => trashFolderAt(path) },
  ];

  const rootMenu = (): MenuItem[] => [
    { label: "Note mới", icon: IconNewNote, onSelect: () => void newNoteIn() },
    { label: "Folder mới", icon: IconNewFolder, onSelect: () => void newFolderIn() },
    { separator: true, label: "" },
    {
      label: "Hiện vault trong File Explorer",
      icon: IconReveal,
      onSelect: () => void api.revealInExplorer("").catch((e) => say(String(e))),
    },
  ];

  const openCtx = (e: MouseEvent, items: MenuItem[]) =>
    setCtxMenu({ x: e.clientX, y: e.clientY, items });

  /** Folder đích cho hộp "Di chuyển tới…" — kèm gốc vault ở đầu. */
  const folderHits = createMemo(() => {
    const q = folderQuery().trim().toLowerCase();
    return ["", ...dirs()].filter((d) => !q || d.toLowerCase().includes(q));
  });

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
        label: `Tạo note "${q}"`,
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

  // ---- Vùng chọn → AI ----

  /** Neo một panel nổi kích thước w×h cạnh vùng chọn, không cho tràn ra ngoài cửa sổ. */
  const anchor = (s: SelectionInfo, w: number, h: number) => {
    const left = Math.max(8, Math.min(s.left, window.innerWidth - w - 8));
    const below = s.bottom + 8;
    const top = below + h + 8 < window.innerHeight ? below : Math.max(70, s.top - h - 8);
    return { left: `${left}px`, top: `${top}px` };
  };

  /** Chỉ hiện khi đang xem note: nút nổi khi popover đóng, popover khi mở. */
  const fabSel = () => (view() === "editor" && current() && !aiOpen() ? sel() : null);
  const popSel = () => (view() === "editor" && current() && aiOpen() ? sel() : null);

  const openAi = () => {
    if (!sel()) return;
    setAiError("");
    setAiPrompt("");
    setAiOpen(true);
    queueMicrotask(() => aiInput?.focus());
  };

  /** Nhờ agent viết lại đúng vùng chọn rồi thay tại chỗ (transaction → Ctrl+Z hoàn tác). */
  const runAi = async (instruction: string) => {
    const s = sel();
    if (!s || aiBusy() || !instruction.trim()) return;
    // Nội dung có thể đã đổi trong lúc chờ agent → không thay bừa vào vị trí cũ.
    if (editor.getContent().slice(s.from, s.to) !== s.text) {
      setAiError("Nội dung đã thay đổi — chọn lại đoạn cần sửa");
      return;
    }
    setAiBusy(true);
    setAiError("");
    try {
      const out = await api.agentTransform(s.text, instruction, currentPath);
      setAiOpen(false);
      setAiPrompt("");
      editor.replaceRange(s.from, s.to, out);
      say("Đã sửa vùng chọn bằng AI — Ctrl+Z để hoàn tác");
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiBusy(false);
    }
  };

  /** Đẩy vùng chọn sang chat Agent — cho yêu cầu phức tạp (cần đọc note khác, tách file…). */
  const sendSelToChat = () => {
    const s = sel();
    if (!s) return;
    setChatSel({ text: s.text, path: currentPath });
    setAiOpen(false);
    if (!chatOpen()) toggleChat();
  };

  /** Mở modal 🕘 lịch sử phiên bản của một note bất kỳ (không nhất thiết đang mở). */
  const openHistoryFor = async (p: string) => {
    setHistPath(p);
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

  const openHistory = () => {
    const p = current();
    if (p) void openHistoryFor(p);
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
    const p = histPath();
    const id = revSel();
    if (!p || id == null) return;
    try {
      const content = await api.historyGet(id);
      // Modal có thể đang xem lịch sử của note khác note đang mở — phải mở nó
      // lên trước, nếu không editor.updateContent sẽ ghi đè nhầm note.
      if (current() !== p) await openNote(p);
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
      dark: isDark(),
      getNotes: notes,
      onSave: saveCurrent,
      onOpenLink: openByTarget,
      onSelection: (s) => {
        setSel(s);
        if (!s) setAiOpen(false);
      },
    });

    // Khôi phục phiên: đọc store rồi mở lại vault gần nhất (kèm tab + tree state).
    // Tuần tự, không fire-and-forget: applyTab cần editor ở trên đã dựng xong.
    void (async () => {
      await initSession();
      const last = recentVaults()[0];
      if (last) await openVaultAt(last);
    })();

    // CodeMirror lấy màu qua var() nên tự đổi, nhưng cờ dark và diagram mermaid
    // (SVG đã render sẵn) thì phải báo tay.
    createEffect(() => editor.setDark(isDark()));

    // Ghi lại workspace mỗi khi tab hoặc trạng thái tree đổi. autoSave của plugin
    // gộp các lần ghi liên tiếp nên chuyển tab nhanh không đập đĩa.
    createEffect(() => {
      const vault = root();
      const ts = tabs();
      const active = activeId();
      const closed = closedDirs();
      // Cửa sổ note rời chỉ có đúng 1 tab — để nó ghi thì bộ tab của cửa sổ
      // chính bị xóa sạch ngay khi mở.
      if (!vault || restoring() || SOLO_NOTE) return;
      const persisted: PersistedTab[] = ts.map((t) => ({
        kind: t.kind,
        path: t.path,
        pinned: t.pinned,
      }));
      const idx = Math.max(0, ts.findIndex((t) => t.id === active));
      void saveWorkspace(vault, { tabs: persisted, activeIndex: idx, closedDirs: [...closed] });
    });

    const unlistenJanitor = listen<JanitorReport>("janitor-report-ready", (e) => {
      setJanitorReport(e.payload);
      setJanitorBadge(true);
    });
    onCleanup(() => {
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
        // Đang mở canvas thì Ctrl+G là "nhóm item đang chọn" (canvas.tsx tự xử
        // lý) — nhường phím, không bật graph view. Hai listener cùng nằm trên
        // window nên nếu không nhường ở đây thì cả hai cùng chạy.
        if (view() === "canvas") return;
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
      } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        void go(e.key === "ArrowLeft" ? -1 : 1);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (!activeTab()?.pinned) closeTab(activeId());
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        openAi();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "`") {
        e.preventDefault();
        setTermVisible((v) => !v);
      } else if (e.key === "Escape") {
        setAiOpen(false);
        setOmniOpen(false);
        setPromptCfg(null);
        setSettingsOpen(false);
        setJanitorOpen(false);
        setHistoryOpen(false);
        setFolderPick(null);
        setConfirmCfg(null);
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
        <button title="Tìm hoặc tạo note (Ctrl+K / Ctrl+O)" onClick={() => { setOmniOpen(true); setOmniQuery(""); setAnswer(null); queueMicrotask(() => omniInput?.focus()); }}><IconSearch /></button>
        <button title="Hỏi đáp vault" onClick={() => { setOmniOpen(true); setOmniQuery("? "); setAnswer(null); queueMicrotask(() => omniInput?.focus()); }}><IconAsk /></button>
        <button title="Graph view (Ctrl+G)" classList={{ active: view() === "graph" }} onClick={toggleGraph}><IconGraph /></button>
        <button title="Daily note hôm nay" onClick={openDaily}><IconDaily /></button>
        <button title="Canvas mới" onClick={newCanvas}><IconCanvas /></button>
        <button title="Janitor: lint & dọn dẹp" onClick={runJanitor}><IconJanitor /></button>
        <button title="Sync GitHub: add → commit → push" disabled={syncBusy()} onClick={gitSync}><IconSync /></button>
        <button title="Chat với agent (sửa nội dung, format, cấu trúc vault)" classList={{ active: chatOpen() }} onClick={toggleChat}><IconAgent /></button>
        <button title="Terminal chạy claude (Ctrl+`)" classList={{ active: termVisible() }} onClick={() => setTermVisible((v) => !v)}><IconTerminal /></button>
        <div class="ribbon-spacer" />
        <button
          title={`Theme: ${theme() === "dark" ? "tối" : "sáng"} — bấm để đổi`}
          onClick={toggleTheme}
        >
          {theme() === "dark" ? <IconDark /> : <IconLight />}
        </button>
        <button title="Vault: chuyển hoặc mở thư mục khác" onClick={() => setVaultOpen(true)}><IconVault /></button>
        <button title="Settings" onClick={openSettings}><IconSettings /></button>
      </nav>

      <aside class="sidebar">
        <div class="sidebar-head">
          <button title="Note mới (Ctrl+N)" onClick={newNote}><IconNewNote /></button>
          <button title="Folder mới" onClick={newFolder}><IconNewFolder /></button>
          <button
            title="Re-index"
            onClick={async () => {
              applyInfo(await api.refresh());
              setCanvases(await api.listCanvases().catch(() => []));
              say(`Re-indexed (${stats()?.index_ms}ms)`);
            }}
          >
            <IconReindex />
          </button>
        </div>
        <Show when={root()} fallback={<div class="tree-empty">Chưa mở vault</div>}>
          <div class="tree-scroll">
            <Show when={bookmarks().length > 0}>
              <details class="bookmarks" open={bmOpen()} onToggle={(e) => setBmOpen(e.currentTarget.open)}>
                <summary class="tree-dir">
                  <IconDirArrow class="tree-dir-arrow" />
                  Bookmark
                </summary>
                <div class="tree-indent">
                  <For each={bookmarks()}>
                    {(b) => (
                      <div
                        class="tree-file"
                        classList={{ active: current() === b.path }}
                        onClick={(e) =>
                          e.ctrlKey ? void openInNewTab(b.path) : void openByPath(b.path)
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openCtx(e, fileMenu(b.path));
                        }}
                        title={b.path}
                      >
                        {b.title}
                      </div>
                    )}
                  </For>
                </div>
              </details>
            </Show>
            <Tree
              notes={treeFiles()}
              dirs={dirs()}
              filter={""}
              current={view() === "canvas" ? canvasPath() : current()}
              editing={treeEditing()}
              closedDirs={closedDirs()}
              onOpen={(p) => void openByPath(p)}
              onOpenNewTab={(p) => void openInNewTab(p)}
              onRename={finishTreeRename}
              onToggleDir={toggleDir}
              onContextNote={(e, p) => openCtx(e, fileMenu(p))}
              onContextDir={(e, p) => openCtx(e, dirMenu(p))}
              onContextRoot={(e) => openCtx(e, rootMenu())}
            />
          </div>
        </Show>
      </aside>

      <main class="main">
        <div class="tabbar">
          <For each={tabs()}>
            {(t) => (
              <div
                class="tab"
                classList={{ active: t.id === activeId(), pinned: t.pinned }}
                onClick={() => switchTab(t.id)}
                onAuxClick={(e) => e.button === 1 && !t.pinned && closeTab(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openCtx(e, tabMenu(t));
                }}
                title={t.path ?? "Tab trống"}
              >
                <Show when={t.pinned}>
                  <IconPin class="tab-pin" />
                </Show>
                <TabIcon kind={t.kind} />
                <span class="tab-label">{tabTitle(t)}</span>
                <button
                  class="tab-close"
                  title="Đóng tab (Ctrl+W)"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  <IconClose />
                </button>
              </div>
            )}
          </For>
          <button class="tab-add" title="Tab mới (Ctrl+T)" onClick={newTab}><IconAdd /></button>
          <div class="tabbar-spacer" />
          <button
            class="tab-add"
            title={rightOpen() ? "Đóng panel phải (backlinks)" : "Mở panel phải (backlinks)"}
            onClick={toggleRight}
          >
            {rightOpen() ? <IconPanelClose /> : <IconPanelOpen />}
          </button>
        </div>
        <div class="note-header">
          <button
            class="nav-btn"
            title="Quay lại (Alt+←)"
            disabled={!canBack()}
            onClick={() => void go(-1)}
          >
            <IconBack />
          </button>
          <button
            class="nav-btn"
            title="Đi tới (Alt+→)"
            disabled={!canForward()}
            onClick={() => void go(1)}
          >
            <IconForward />
          </button>
          <span class="note-path">
            <Show when={view() === "graph"}>
              <IconGraph />
            </Show>
            <Show when={view() === "canvas"}>
              <IconCanvas />
            </Show>
            {view() === "graph" ? "Graph view" : view() === "canvas" ? canvasPath() ?? "" : current() ?? ""}
          </span>
          <Show when={view() === "editor" && current()}>
            <button title="Lịch sử phiên bản (mọi thay đổi của bạn & AI)" onClick={openHistory}><IconHistory /></button>
            <button title="Đổi tên / di chuyển" onClick={renameCurrent}><IconRename /></button>
            <button title="Chuyển vào thùng rác" onClick={trashCurrent}><IconTrash /></button>
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
                : "Mở một vault (thư mục chứa file .md) để bắt đầu."}
            </p>
            <Show when={!root()}>
              <Show when={recentVaults().length > 0}>
                <div class="recent-title">Vault gần đây</div>
                <VaultList />
              </Show>
              <button class="vault-browse" onClick={pickVault}>
                Chọn thư mục khác…
              </button>
            </Show>
            <p class="hint">
              Ctrl+K tìm/tạo · ? hỏi đáp · Ctrl+G graph · daily note · [[ autocomplete · Ctrl+Click mở link
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
              getNotes={notes}
              onOpenNote={openNote}
              requestNotePick={openNotePicker}
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
                <div class="backlink-path">{r.reason || r.path}</div>
              </div>
            )}
          </For>
        </Show>
      </aside>

      {/* Vùng chọn trong note → nút nổi "Sửa bằng AI" (Ctrl+Shift+L) */}
      <Show when={fabSel()}>
        {(s) => (
          <button class="sel-fab" style={anchor(s(), 210, 30)} onClick={openAi}>
            <IconAi /> Sửa bằng AI <span class="sel-kbd">Ctrl+Shift+L</span>
          </button>
        )}
      </Show>

      <Show when={popSel()}>
        {(s) => (
          <div class="sel-pop" style={anchor(s(), 360, 190)}>
            <div class="sel-pop-head">
              <span><IconAi /> Sửa {s().text.length} ký tự đã chọn</span>
              <button title="Đóng (Esc)" onClick={() => setAiOpen(false)}>
                <IconClose />
              </button>
            </div>
            <input
              ref={aiInput}
              placeholder="VD: format thành table markdown"
              value={aiPrompt()}
              disabled={aiBusy()}
              onInput={(e) => setAiPrompt(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  runAi(aiPrompt());
                }
              }}
            />
            <div class="sel-pop-actions">
              <For each={SELECTION_ACTIONS}>
                {(a) => (
                  <button class="sel-chip" disabled={aiBusy()} onClick={() => runAi(a.prompt)}>
                    <a.icon />
                    {a.label}
                  </button>
                )}
              </For>
            </div>
            <div class="sel-pop-foot">
              <Show
                when={aiBusy()}
                fallback={<span class="sel-hint">Enter để chạy · thay tại chỗ, Ctrl+Z hoàn tác</span>}
              >
                <span class="sel-hint">
                  <span class="chat-spinner" /> agent đang viết lại…
                </span>
              </Show>
              <button class="sel-tochat" disabled={aiBusy()} onClick={sendSelToChat}>
                <IconSend /> Gửi vào chat Agent
              </button>
            </div>
            <Show when={aiError()}>
              <div class="sel-error">{aiError()}</div>
            </Show>
          </div>
        )}
      </Show>

      <ChatPanel
        visible={chatOpen()}
        currentPath={current()}
        selection={chatSel()}
        onClearSelection={() => setChatSel(null)}
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
            <IconJanitor /> báo cáo mới
          </span>
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

      <Show when={vaultOpen()}>
        <div class="overlay" onClick={() => setVaultOpen(false)}>
          <div class="prompt-modal settings-modal" onClick={(e) => e.stopPropagation()}>
            <div class="prompt-title">Vault</div>
            <div class="settings-body">
              <Show
                when={recentVaults().length > 0}
                fallback={<div class="recent-empty">Chưa mở vault nào.</div>}
              >
                <VaultList />
              </Show>
              <button class="vault-browse" onClick={pickVault}>
                Chọn thư mục khác…
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={settingsOpen()}>
        <div class="overlay" onClick={() => setSettingsOpen(false)}>
          <div class="prompt-modal settings-modal" onClick={(e) => e.stopPropagation()}>
            <div class="prompt-title">Settings</div>
            <div class="settings-body">
              <div class="settings-section">Giao diện</div>
              <div class="theme-choices">
                <For
                  each={
                    [
                      { v: "system", label: "Theo hệ thống", icon: IconSystemTheme },
                      { v: "light", label: "Sáng", icon: IconLight },
                      { v: "dark", label: "Tối", icon: IconDark },
                    ] as { v: ThemePref; label: string; icon: typeof IconLight }[]
                  }
                >
                  {(opt) => (
                    <button
                      class="theme-choice"
                      classList={{ active: themePref() === opt.v }}
                      onClick={() => setThemePref(opt.v)}
                    >
                      <opt.icon />
                      <span>{opt.label}</span>
                    </button>
                  )}
                </For>
              </div>
              <div class="settings-section">LLM cho hỏi đáp & reasoning search</div>
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
                      {opt.v === "claude" && (llm()?.claude_ok ? <><IconOk /> có sẵn</> : <><IconClose /> không thấy trên PATH</>)}
                      {opt.v === "codex" && (llm()?.codex_ok ? <><IconOk /> có sẵn</> : <><IconClose /> không thấy trên PATH</>)}
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
              <IconJanitor /> Janitor
              <Show when={janitorReport()}>
                {" — snapshot: "}
                {janitorReport()!.snapshotted ? <><IconOk /> git</> : <><IconClose /> (cài git để an toàn hơn)</>}
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
                    {(a) => <div class="jan-item jan-ok"><IconOk /> {a.description}</div>}
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
                  <div class="ask-hint"><IconAllClear /> Vault sạch sẽ, không có gì để làm</div>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={historyOpen()}>
        <div class="overlay" onClick={() => setHistoryOpen(false)}>
          <div class="prompt-modal history-modal" onClick={(e) => e.stopPropagation()}>
            <div class="prompt-title"><IconHistory /> Lịch sử phiên bản — {current()}</div>
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
                      <IconRestore /> Khôi phục bản này
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={notePick()}>
        <div class="overlay" onClick={() => setNotePick(null)}>
          <div class="omnibar" onClick={(e) => e.stopPropagation()}>
            <input
              ref={pickInput}
              placeholder="Tìm note để gắn vào canvas…"
              value={pickQuery()}
              onInput={(e) => {
                setPickQuery(e.currentTarget.value);
                setPickSel(0);
              }}
              onKeyDown={(e) => {
                const n = pickHits().length;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setPickSel((i) => (n ? (i + 1) % n : 0));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setPickSel((i) => (n ? (i - 1 + n) % n : 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  confirmPick();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setNotePick(null);
                }
              }}
            />
            <div class="omni-results">
              <Show
                when={pickHits().length > 0}
                fallback={<div class="omni-item omni-sub">Không có note nào khớp</div>}
              >
                <For each={pickHits()}>
                  {(n, i) => (
                    <div
                      class="omni-item"
                      classList={{ selected: i() === pickSel() }}
                      onMouseEnter={() => setPickSel(i())}
                      onClick={confirmPick}
                    >
                      <div class="omni-label">{n.title}</div>
                      <div class="omni-sub">
                        {n.path} · {fmtAgo(n.mtime)}
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </div>
            <div class="prompt-hint">
              {pickQuery().trim() ? "Kết quả tìm kiếm" : "Sửa gần đây"} · ↑↓ chọn · Enter gắn vào
              canvas · Esc hủy
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

      <Show when={folderPick()}>
        <div class="overlay" onClick={() => setFolderPick(null)}>
          <div class="prompt-modal" onClick={(e) => e.stopPropagation()}>
            <div class="prompt-title">{folderPick()!.title}</div>
            <input
              autofocus
              placeholder="Lọc folder…"
              value={folderQuery()}
              onInput={(e) => setFolderQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setFolderPick(null);
              }}
            />
            <div class="omni-results">
              <For each={folderHits()}>
                {(d) => (
                  <div
                    class="omni-item"
                    onClick={() => {
                      const cfg = folderPick()!;
                      setFolderPick(null);
                      cfg.onOk(d);
                    }}
                  >
                    <div class="omni-label">{d || "(gốc vault)"}</div>
                  </div>
                )}
              </For>
            </div>
            <div class="prompt-hint">Chọn folder đích · Esc để hủy</div>
          </div>
        </div>
      </Show>

      <Show when={confirmCfg()}>
        {(c) => (
          <div class="overlay" onClick={() => setConfirmCfg(null)}>
            <div
              class="confirm-modal"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmNow();
              }}
            >
              <div class="confirm-head">
                <div class="confirm-title">{c().title}</div>
                <button class="confirm-x" title="Đóng" onClick={() => setConfirmCfg(null)}>
                  <IconClose />
                </button>
              </div>
              <div class="confirm-body">
                <p>{c().message}</p>
                <p class="confirm-detail">{c().detail}</p>
              </div>
              <div class="confirm-foot">
                <label class="confirm-skip">
                  <input
                    type="checkbox"
                    checked={dontAsk()}
                    onChange={(e) => setDontAsk(e.currentTarget.checked)}
                  />
                  Đừng hỏi lại
                </label>
                <div class="confirm-actions">
                  <button class="btn-danger" autofocus onClick={confirmNow}>
                    {c().confirmLabel}
                  </button>
                  <button class="btn-plain" onClick={() => setConfirmCfg(null)}>
                    Hủy
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={ctxMenu()}>
        {(m) => <ContextMenu anchor={m()} onClose={() => setCtxMenu(null)} />}
      </Show>

      <DragGhost />
    </div>
  );
}
