// Phiên làm việc lưu qua tauri-plugin-store (file settings.json trong app data dir).
// Chứa 2 thứ: danh sách vault gần đây, và workspace của từng vault (tab đang mở +
// folder đã thu gọn trong tree). Preference giao diện (chatOpen/rightOpen/llmPref)
// vẫn ở localStorage vì chúng được đọc đồng bộ lúc khởi tạo signal.
import { load, type Store } from "@tauri-apps/plugin-store";
import { createSignal } from "solid-js";

export interface PersistedTab {
  kind: "empty" | "note" | "graph" | "canvas";
  /** note: path .md · canvas: path .canvas · graph/empty: null */
  path: string | null;
  /** Tab ghim. Lịch sử điều hướng KHÔNG lưu — mở lại app là bắt đầu lại. */
  pinned?: boolean;
}

export interface Workspace {
  tabs: PersistedTab[];
  activeIndex: number;
  /** Folder bị thu gọn. Lưu "đã đóng" chứ không phải "đang mở" để folder mới
   *  vẫn mặc định bung ra, đúng hành vi <details open> hiện tại. */
  closedDirs: string[];
}

export interface Bookmark {
  /** Path .md trong vault. */
  path: string;
  /** Tên hiển thị, người dùng đặt lúc bookmark (mặc định = tên file). */
  title: string;
}

const FILE = "settings.json";
const RECENT_MAX = 8;

let store: Store | null = null;
let workspaces: Record<string, Workspace> = {};
let bookmarks: Record<string, Bookmark[]> = {};

// Signal để UI (danh sách recent ở empty-state và modal 🗂) tự cập nhật.
const [recentVaults, setRecentVaults] = createSignal<string[]>([]);
export { recentVaults };

/** Đọc store vào bộ nhớ. Gọi một lần lúc onMount, trước mọi thứ khác. */
export async function initSession(): Promise<void> {
  try {
    // autoSave: plugin tự gộp các lần ghi liên tiếp rồi flush xuống đĩa sau 200ms,
    // nên đổi tab liên tục không đập đĩa và không cần gọi save() thủ công.
    store = await load(FILE, { autoSave: 200 });
    const recent = (await store.get<string[]>("recentVaults")) ?? null;
    workspaces = (await store.get<Record<string, Workspace>>("workspaces")) ?? {};
    bookmarks = (await store.get<Record<string, Bookmark[]>>("bookmarks")) ?? {};

    if (recent) {
      setRecentVaults(recent);
      return;
    }
    // Bản cũ chỉ nhớ đúng 1 vault trong localStorage — chuyển sang store một lần.
    const legacy = localStorage.getItem("vaultPath");
    if (legacy) {
      setRecentVaults([legacy]);
      await store.set("recentVaults", [legacy]);
    }
  } catch (e) {
    // Store hỏng/không ghi được thì app vẫn phải chạy, chỉ là không nhớ phiên.
    console.error("không đọc được settings.json:", e);
    store = null;
  }
}

/** Đưa vault lên đầu danh sách gần đây (không trùng lặp, tối đa RECENT_MAX). */
export async function pushRecentVault(path: string): Promise<void> {
  const next = [path, ...recentVaults().filter((p) => p !== path)].slice(0, RECENT_MAX);
  setRecentVaults(next);
  await store?.set("recentVaults", next).catch(() => {});
}

/** Bỏ một vault khỏi danh sách gần đây (nút × trên từng dòng). */
export async function forgetVault(path: string): Promise<void> {
  setRecentVaults((r) => r.filter((p) => p !== path));
  delete workspaces[path];
  delete bookmarks[path];
  await store?.set("recentVaults", recentVaults()).catch(() => {});
  await store?.set("workspaces", workspaces).catch(() => {});
  await store?.set("bookmarks", bookmarks).catch(() => {});
}

export function getWorkspace(vault: string): Workspace | null {
  return workspaces[vault] ?? null;
}

export async function saveWorkspace(vault: string, ws: Workspace): Promise<void> {
  workspaces[vault] = ws;
  await store?.set("workspaces", workspaces).catch(() => {});
}

export function getBookmarks(vault: string): Bookmark[] {
  return bookmarks[vault] ?? [];
}

export async function saveBookmarks(vault: string, list: Bookmark[]): Promise<void> {
  bookmarks[vault] = list;
  await store?.set("bookmarks", bookmarks).catch(() => {});
}
