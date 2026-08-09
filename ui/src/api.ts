import { invoke } from "@tauri-apps/api/core";

export interface NoteMeta {
  path: string;
  title: string;
  /** Unix epoch giây — sắp xếp "sửa gần đây". */
  mtime: number;
}

export interface Stats {
  notes: number;
  links: number;
  broken: number;
  tags: number;
  chunks: number;
  index_ms: number;
}

export interface VaultInfo {
  root: string;
  notes: NoteMeta[];
  dirs: string[];
  stats: Stats;
}

export interface SearchHit {
  path: string;
  title: string;
  heading_path: string;
  start_line: number;
  snippet: string;
}

export interface Backlink {
  src_path: string;
  src_title: string;
  kind: string;
}

export interface RelatedNote {
  path: string;
  title: string;
  /** Vì sao liên quan ("2 tag chung · trùng từ khóa"). */
  reason: string;
}

export const api = {
  openVault: (path: string) => invoke<VaultInfo>("open_vault", { path }),
  refresh: () => invoke<VaultInfo>("refresh"),
  readNote: (path: string) => invoke<string>("read_note", { path }),
  writeNote: (path: string, content: string) =>
    invoke<null>("write_note", { path, content, withInfo: false }),
  /** Lưu rồi trả luôn VaultInfo đã index — khỏi gọi refresh() thêm một lượt. */
  writeNoteWithInfo: (path: string, content: string) =>
    invoke<VaultInfo>("write_note", { path, content, withInfo: true }),
  createNote: (path: string) => invoke<string>("create_note", { path }),
  createFolder: (path: string) => invoke<string>("create_folder", { path }),
  renameFolder: (from: string, to: string) =>
    invoke<void>("rename_folder", { from, to }),
  renameNote: (from: string, to: string) =>
    invoke<number>("rename_note", { from, to }),
  trashNote: (path: string) => invoke<void>("trash_note", { path }),
  trashFolder: (path: string) => invoke<void>("trash_folder", { path }),
  duplicateNote: (path: string) => invoke<string>("duplicate_note", { path }),
  /** Đổi tên/di chuyển file không phải note (canvas…). Trả path mới. */
  renameFile: (from: string, to: string) => invoke<string>("rename_file", { from, to }),
  /** Đường dẫn tuyệt đối dạng native; path rỗng = thư mục gốc vault. */
  absPath: (path: string) => invoke<string>("abs_path", { path }),
  revealInExplorer: (path: string) => invoke<void>("reveal_in_explorer", { path }),
  openExternal: (path: string) => invoke<void>("open_external", { path }),
  openNoteWindow: (path: string) => invoke<void>("open_note_window", { path }),
  search: (query: string, limit = 20) =>
    invoke<SearchHit[]>("search_notes", { query, limit }),
  backlinks: (path: string) => invoke<Backlink[]>("backlinks", { path }),
  resolveLink: (target: string) =>
    invoke<string | null>("resolve_link", { target }),
  relatedNotes: (path: string) => invoke<RelatedNote[]>("related_notes", { path }),
  unlinkedMentions: (path: string) =>
    invoke<SearchHit[]>("unlinked_mentions", { path }),
  ask: (question: string) => invoke<AnswerDto>("ask_vault", { question }),
  getLlmSettings: () => invoke<LlmSettings>("get_llm_settings"),
  setLlmPref: (pref: string) => invoke<void>("set_llm_pref", { pref }),
  janitorRun: () => invoke<JanitorReport>("janitor_run"),
  janitorLatest: () => invoke<JanitorReport | null>("janitor_latest"),
  janitorApply: (actionId: number) => invoke<string>("janitor_apply", { actionId }),
  janitorDismiss: (actionId: number) => invoke<void>("janitor_dismiss", { actionId }),
  graphData: () => invoke<GraphData>("graph_data"),
  listCanvases: () => invoke<string[]>("list_canvases"),
  saveAsset: (name: string, dataBase64: string) =>
    invoke<string>("save_asset", { name, dataBase64 }),
  importAsset: (src: string) => invoke<string>("import_asset", { src }),
  readAsset: (path: string) => invoke<string>("read_asset", { path }),
  gitSync: () => invoke<string>("git_sync"),
  noteHistory: (path: string) => invoke<RevisionMeta[]>("note_history", { path }),
  historyGet: (id: number) => invoke<string>("history_get", { id }),
  agentChat: (message: string, contextPath: string | null, sessionId: string | null) =>
    invoke<AgentReply>("agent_chat", { message, contextPath, sessionId }),
  /** Sửa đúng vùng chọn: trả về text mới cho vùng đó, UI tự thay vào editor. */
  agentTransform: (selection: string, instruction: string, contextPath: string | null) =>
    invoke<string>("agent_transform", { selection, instruction, contextPath }),
  termOpen: (cols: number, rows: number) => invoke<number>("term_open", { cols, rows }),
  termWrite: (id: number, data: string) => invoke<void>("term_write", { id, data }),
  termResize: (id: number, cols: number, rows: number) =>
    invoke<void>("term_resize", { id, cols, rows }),
  termKill: (id: number) => invoke<void>("term_kill", { id }),
};

export interface AgentReply {
  text: string;
  session_id: string | null;
  provider: string;
}

export interface RevisionMeta {
  id: number;
  ts: number;
  chars: number;
}

export interface GraphData {
  nodes: { path: string; title: string; degree: number }[];
  edges: { from: string; to: string }[];
}

export interface LlmSettings {
  pref: string;
  claude_ok: boolean;
  codex_ok: boolean;
  active: string | null;
}

export interface JanitorAction {
  id: number;
  rule: string;
  severity: string;
  description: string;
  status: string;
}

export interface JanitorReport {
  run_id: number;
  ts: number;
  snapshotted: boolean;
  applied: JanitorAction[];
  proposals: JanitorAction[];
  suggestions: JanitorAction[];
}

export interface AnswerDto {
  answer: string;
  provider: string;
  sources: { path: string; heading_path: string; start_line: number }[];
}
