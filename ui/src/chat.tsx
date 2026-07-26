import { listen } from "@tauri-apps/api/event";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api } from "./api";

interface Msg {
  role: "user" | "agent";
  text: string;
  provider?: string;
  /** Vùng chọn đã đính kèm vào tin nhắn này (chỉ để hiển thị lại). */
  attached?: string;
}

/** Quick prompt nhắc tới note thì ghi đích danh path — agent không phải đoán "note đang mở". */
const QUICK_PROMPTS: {
  label: string;
  needsNote?: boolean;
  text: (path: string | null) => string;
}[] = [
  {
    label: "✨ Làm đẹp note đang mở",
    needsNote: true,
    text: (p) =>
      `Làm đẹp format cho đúng một file: "${p}". Chuẩn hóa heading, danh sách, code block, bảng. Giữ nguyên nội dung và wikilink. Không sửa file nào khác.`,
  },
  {
    label: "🔗 Sửa link gãy",
    text: () =>
      "Tìm các wikilink gãy trong vault và sửa lại cho trỏ đúng note (đổi tên gần đúng, heading đổi…). Liệt kê các link đã sửa.",
  },
  {
    label: "🗂 Gợi ý cấu trúc vault",
    text: () =>
      "Phân tích cấu trúc thư mục và tên file của vault, đề xuất cách tổ chức lại hợp lý hơn. Chỉ đề xuất, chưa di chuyển file.",
  },
];

/** Prompt sẵn cho vùng chọn đính kèm — bấm là gửi luôn. */
const SELECTION_PROMPTS = [
  "Format đoạn này thành table markdown",
  "Viết lại cho gọn và rõ hơn",
  "Chuyển thành danh sách gạch đầu dòng",
  "Sửa chính tả và ngữ pháp",
];

/** Vùng chọn được đẩy từ editor sang chat (📌) để agent sửa đúng đoạn đó. */
export interface ChatSelection {
  text: string;
  path: string | null;
}

/** Sidebar chat với agent (Claude Code / Codex headless) — agent chạy với cwd là vault
 *  nên có thể trực tiếp sửa nội dung file, format, hoặc tái cấu trúc theo yêu cầu. */
export function ChatPanel(props: {
  visible: boolean;
  currentPath: string | null;
  /** Đoạn text người dùng đính kèm từ editor (null = không có). */
  selection: ChatSelection | null;
  onClearSelection: () => void;
  onVaultChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [msgs, setMsgs] = createSignal<Msg[]>([]);
  const [input, setInput] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal("");
  const [useContext, setUseContext] = createSignal(true);
  let sessionId: string | null = null;
  let scroller: HTMLDivElement | undefined;
  let box: HTMLTextAreaElement | undefined;

  const scrollDown = () =>
    queueMicrotask(() => scroller && (scroller.scrollTop = scroller.scrollHeight));

  onMount(() => {
    const un = listen<{ label: string }>("agent-progress", (e) => {
      setProgress(e.payload.label);
      scrollDown();
    });
    onCleanup(() => un.then((f) => f()));
  });

  /** Có vùng chọn đính kèm → bọc yêu cầu lại, khoanh vùng đúng đoạn đó cho agent. */
  const withSelection = (instruction: string) => {
    const sel = props.selection;
    if (!sel) return instruction;
    const where = sel.path ? ` trong note "${sel.path}"` : "";
    return (
      `Chỉ sửa ĐÚNG đoạn được chọn dưới đây${where} — không đụng phần còn lại của file, ` +
      `không sửa file khác.\n\n--- ĐOẠN ĐƯỢC CHỌN ---\n${sel.text}\n--- HẾT ĐOẠN ---\n\n` +
      `Yêu cầu: ${instruction}`
    );
  };

  const send = async (preset?: string) => {
    const raw = (preset ?? input()).trim();
    if (!raw || busy()) return;
    const message = withSelection(raw);
    const attached = props.selection?.text;
    props.onClearSelection();
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: raw, attached }]);
    setBusy(true);
    setProgress("khởi động agent…");
    scrollDown();
    try {
      const ctx = useContext() ? props.currentPath : null;
      const r = await api.agentChat(message, ctx, sessionId);
      sessionId = r.session_id ?? sessionId;
      setMsgs((m) => [...m, { role: "agent", text: r.text, provider: r.provider }]);
      await props.onVaultChanged();
    } catch (e) {
      setMsgs((m) => [...m, { role: "agent", text: String(e), provider: "lỗi" }]);
    } finally {
      setBusy(false);
      setProgress("");
      scrollDown();
    }
  };

  const newSession = () => {
    sessionId = null;
    setMsgs([]);
  };

  return (
    <aside class="chatbar" style={{ display: props.visible ? "flex" : "none" }}>
      <div class="chat-head">
        <span class="chat-title">🤖 Agent</span>
        <button title="Phiên mới (xóa ngữ cảnh hội thoại)" onClick={newSession}>
          ⟳
        </button>
        <button title="Đóng panel chat" onClick={props.onClose}>
          ×
        </button>
      </div>

      <div class="chat-scroll" ref={scroller}>
        <Show when={msgs().length === 0}>
          <div class="chat-empty">
            <p>Nhờ agent sửa nội dung, làm đẹp format, hay tổ chức lại vault — agent chạy Claude Code ngay trong vault của bạn.</p>
            {/* Đang đính kèm vùng chọn thì các prompt toàn-vault này không còn phù hợp. */}
            <Show when={!props.selection}>
              <For each={QUICK_PROMPTS}>
                {(q) => (
                  <button
                    class="chat-chip"
                    disabled={busy() || (q.needsNote && !props.currentPath)}
                    title={q.needsNote && !props.currentPath ? "Mở một note trước đã" : undefined}
                    onClick={() => send(q.text(props.currentPath))}
                  >
                    {q.label}
                  </button>
                )}
              </For>
            </Show>
          </div>
        </Show>
        <For each={msgs()}>
          {(m) => (
            <div class="chat-msg" classList={{ user: m.role === "user", agent: m.role === "agent" }}>
              <Show when={m.provider}>
                <div class="chat-provider">{m.provider}</div>
              </Show>
              <Show when={m.attached}>
                <div class="chat-quote">{m.attached}</div>
              </Show>
              <div class="chat-text">{m.text}</div>
            </div>
          )}
        </For>
        <Show when={busy()}>
          <div class="chat-progress">
            <span class="chat-spinner" /> {progress() || "đang chạy…"}
          </div>
        </Show>
      </div>

      <div class="chat-input">
        <Show when={props.selection}>
          {(sel) => (
            <div class="chat-attach">
              <div class="chat-attach-head">
                <span>📌 Vùng chọn ({sel().text.length} ký tự)</span>
                <button title="Bỏ đính kèm" onClick={props.onClearSelection}>
                  ×
                </button>
              </div>
              <div class="chat-quote">{sel().text}</div>
              <div class="chat-attach-prompts">
                <For each={SELECTION_PROMPTS}>
                  {(p) => (
                    <button class="chat-chip mini" disabled={busy()} onClick={() => send(p)}>
                      {p}
                    </button>
                  )}
                </For>
              </div>
            </div>
          )}
        </Show>
        <label class="chat-ctx" title="Cho agent biết note bạn đang mở">
          <input
            type="checkbox"
            checked={useContext()}
            onChange={(e) => setUseContext(e.currentTarget.checked)}
          />
          📎 note đang mở{props.currentPath ? `: ${props.currentPath.split("/").pop()}` : ""}
        </label>
        <textarea
          ref={box}
          rows={3}
          placeholder={
            props.selection
              ? "Sửa vùng chọn thế nào? (VD: format thành table markdown)"
              : "Yêu cầu agent… (Enter gửi, Shift+Enter xuống dòng)"
          }
          value={input()}
          disabled={busy()}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button class="chat-send" disabled={busy() || !input().trim()} onClick={() => send()}>
          {busy() ? "Đang chạy…" : "Gửi"}
        </button>
      </div>
    </aside>
  );
}
