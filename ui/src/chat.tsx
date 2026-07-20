import { listen } from "@tauri-apps/api/event";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api } from "./api";

interface Msg {
  role: "user" | "agent";
  text: string;
  provider?: string;
}

const QUICK_PROMPTS = [
  { label: "✨ Làm đẹp note này", text: "Làm đẹp format note đang mở: chuẩn hóa heading, danh sách, code block, bảng. Giữ nguyên nội dung và wikilink." },
  { label: "🔗 Sửa link gãy", text: "Tìm các wikilink gãy trong vault và sửa lại cho trỏ đúng note (đổi tên gần đúng, heading đổi…). Liệt kê các link đã sửa." },
  { label: "🗂 Gợi ý cấu trúc vault", text: "Phân tích cấu trúc thư mục và tên file của vault, đề xuất cách tổ chức lại hợp lý hơn. Chỉ đề xuất, chưa di chuyển file." },
];

/** Sidebar chat với agent (Claude Code / Codex headless) — agent chạy với cwd là vault
 *  nên có thể trực tiếp sửa nội dung file, format, hoặc tái cấu trúc theo yêu cầu. */
export function ChatPanel(props: {
  visible: boolean;
  currentPath: string | null;
  onVaultChanged: () => Promise<void>;
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

  const send = async (preset?: string) => {
    const text = (preset ?? input()).trim();
    if (!text || busy()) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    setProgress("khởi động agent…");
    scrollDown();
    try {
      const ctx = useContext() ? props.currentPath : null;
      const r = await api.agentChat(text, ctx, sessionId);
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
      </div>

      <div class="chat-scroll" ref={scroller}>
        <Show when={msgs().length === 0}>
          <div class="chat-empty">
            <p>Nhờ agent sửa nội dung, làm đẹp format, hay tổ chức lại vault — agent chạy Claude Code ngay trong vault của bạn.</p>
            <For each={QUICK_PROMPTS}>
              {(q) => (
                <button class="chat-chip" disabled={busy()} onClick={() => send(q.text)}>
                  {q.label}
                </button>
              )}
            </For>
          </div>
        </Show>
        <For each={msgs()}>
          {(m) => (
            <div class="chat-msg" classList={{ user: m.role === "user", agent: m.role === "agent" }}>
              <Show when={m.provider}>
                <div class="chat-provider">{m.provider}</div>
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
          placeholder="Yêu cầu agent… (Enter gửi, Shift+Enter xuống dòng)"
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
