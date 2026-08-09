// Render markdown ở chế độ CHỈ ĐỌC cho các chỗ không dựng nổi CodeMirror:
// card trên canvas (một canvas có thể có hàng chục card — mỗi card một EditorView
// thì quá nặng). Chỉ phủ tập cú pháp hay dùng trong một ghi chú ngắn; muốn đầy đủ
// (mermaid, bảng, footnote…) thì mở note ra trong editor chính.
//
// Link (wikilink, URL, markdown link) tách riêng ở `LinkifiedText` vì cần gọi
// api.resolveLink — inline formatter bên dưới chạy TRƯỚC nó và chừa nguyên phần
// link lại cho nó xử lý.
import { createMemo, For, Match, Show, Switch } from "solid-js";
import { api } from "./api";

const LINKIFY =
  /(!?\[\[([^\[\]]+?)\]\])|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>"')\]]+)/g;

type LinkPart =
  | { t: "text"; s: string }
  | { t: "url"; href: string; label: string }
  | { t: "wiki"; target: string; label: string };

/** Chuỗi có link (wikilink / URL / [label](url)) → span + anchor bấm được. */
export function LinkifiedText(props: {
  text: string;
  onOpenNote: (path: string) => void;
}) {
  const parts = createMemo<LinkPart[]>(() => {
    const out: LinkPart[] = [];
    const text = props.text;
    let last = 0;
    for (const m of text.matchAll(LINKIFY)) {
      if (m.index! > last) out.push({ t: "text", s: text.slice(last, m.index) });
      if (m[1]) {
        const inner = m[2];
        const pipe = inner.indexOf("|");
        const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).split("#")[0].trim();
        out.push({ t: "wiki", target, label: pipe >= 0 ? inner.slice(pipe + 1) : inner });
      } else if (m[3]) {
        out.push({ t: "url", href: m[5], label: m[4] });
      } else {
        out.push({ t: "url", href: m[6], label: m[6] });
      }
      last = m.index! + m[0].length;
    }
    if (last < text.length) out.push({ t: "text", s: text.slice(last) });
    return out;
  });

  const openWiki = async (target: string) => {
    const p = await api.resolveLink(target).catch(() => null);
    if (p) props.onOpenNote(p);
  };

  return (
    <For each={parts()}>
      {(p) =>
        p.t === "text" ? (
          <span>{p.s}</span>
        ) : p.t === "url" ? (
          <a
            class="canvas-link"
            href={p.href}
            title={p.href}
            onMouseDown={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              window.open(p.href, "_blank");
            }}
          >
            {p.label}
          </a>
        ) : (
          <a
            class="canvas-link canvas-link-wiki"
            title={`Mở "${p.target}"`}
            onMouseDown={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void openWiki(p.target);
            }}
          >
            {p.label}
          </a>
        )
      }
    </For>
  );
}

// ---- inline: **đậm**, *nghiêng*, `code`, ~~gạch~~ ----

type Span =
  | { t: "plain"; s: string }
  | { t: "strong" | "em" | "code" | "del"; s: string };

// Thứ tự quan trọng: `**` phải đứng trước `*`, nếu không `*` nuốt mất một dấu sao.
const INLINE = /(\*\*|__)(.+?)\1|(~~)(.+?)\3|(`)([^`]+?)\5|(\*|_)(.+?)\7/g;

function inlineSpans(text: string): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push({ t: "plain", s: text.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ t: "strong", s: m[2] });
    else if (m[4] !== undefined) out.push({ t: "del", s: m[4] });
    else if (m[6] !== undefined) out.push({ t: "code", s: m[6] });
    else out.push({ t: "em", s: m[8] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ t: "plain", s: text.slice(last) });
  return out;
}

/** Một đoạn text: format inline rồi mới linkify phần chữ thường. */
function Inline(props: { text: string; onOpenNote: (path: string) => void }) {
  const spans = createMemo(() => inlineSpans(props.text));
  return (
    <For each={spans()}>
      {(s) =>
        s.t === "plain" ? (
          <LinkifiedText text={s.s} onOpenNote={props.onOpenNote} />
        ) : s.t === "code" ? (
          <code class="md-code">{s.s}</code>
        ) : s.t === "strong" ? (
          <strong>
            <Inline text={s.s} onOpenNote={props.onOpenNote} />
          </strong>
        ) : s.t === "del" ? (
          <del>
            <Inline text={s.s} onOpenNote={props.onOpenNote} />
          </del>
        ) : (
          <em>
            <Inline text={s.s} onOpenNote={props.onOpenNote} />
          </em>
        )
      }
    </For>
  );
}

// ---- block: heading, bullet, số thứ tự, trích dẫn, code fence, checkbox ----

interface ListItem {
  s: string;
  /** undefined = không phải checkbox. */
  done?: boolean;
}

type Block =
  | { t: "h"; level: number; s: string }
  | { t: "p"; s: string }
  | { t: "quote"; s: string }
  | { t: "fence"; s: string }
  | { t: "list"; ordered: boolean; items: ListItem[] };

function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ```code``` — gom tới fence đóng, hoặc hết văn bản nếu người dùng chưa đóng.
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ t: "fence", s: body.join("\n") });
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push({ t: "h", level: h[1].length, s: h[2] });
      i++;
      continue;
    }

    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      const body = [q[1]];
      i++;
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i++].replace(/^\s*>\s?/, ""));
      }
      out.push({ t: "quote", s: body.join("\n") });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || num) {
      const ordered = !bullet;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = ordered
          ? lines[i].match(/^\s*\d+[.)]\s+(.*)$/)
          : lines[i].match(/^\s*[-*+]\s+(.*)$/);
        if (!m) break;
        const box = m[1].match(/^\[([ xX])\]\s+(.*)$/);
        items.push(box ? { s: box[2], done: box[1] !== " " } : { s: m[1] });
        i++;
      }
      out.push({ t: "list", ordered, items });
      continue;
    }

    // Đoạn văn: gom các dòng liền nhau, dòng trống kết thúc đoạn.
    if (!line.trim()) {
      i++;
      continue;
    }
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(\s*```|#{1,6}\s|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    out.push({ t: "p", s: para.join("\n") });
  }
  return out;
}

/** Markdown chỉ đọc. `text` rỗng → không render gì (chỗ gọi tự lo placeholder). */
export function Markdown(props: { text: string; onOpenNote: (path: string) => void }) {
  const blocks = createMemo(() => parseBlocks(props.text));
  return (
    <div class="md">
      <For each={blocks()}>
        {(b) => (
          <Switch>
            <Match when={b.t === "fence" ? b : null}>
              {(f) => <pre class="md-fence">{f().s}</pre>}
            </Match>
            <Match when={b.t === "list" ? b : null}>
              {(l) => <MdList block={l()} onOpenNote={props.onOpenNote} />}
            </Match>
            <Match when={b.t === "h" ? b : null}>
              {(h) => (
                <div class={`md-h md-h${h().level}`}>
                  <Inline text={h().s} onOpenNote={props.onOpenNote} />
                </div>
              )}
            </Match>
            <Match when={b.t === "quote" ? b : null}>
              {(q) => (
                <blockquote class="md-quote">
                  <Inline text={q().s} onOpenNote={props.onOpenNote} />
                </blockquote>
              )}
            </Match>
            <Match when={b.t === "p" ? b : null}>
              {(p) => (
                <p class="md-p">
                  <Inline text={p().s} onOpenNote={props.onOpenNote} />
                </p>
              )}
            </Match>
          </Switch>
        )}
      </For>
    </div>
  );
}

function MdList(props: {
  block: { ordered: boolean; items: ListItem[] };
  onOpenNote: (path: string) => void;
}) {
  return (
    <Show
      when={props.block.ordered}
      fallback={
        <ul class="md-list">
          <For each={props.block.items}>
            {(it) => (
              <li classList={{ done: it.done }}>
                <Show when={it.done !== undefined}>
                  <input type="checkbox" checked={it.done} disabled />
                </Show>
                <Inline text={it.s} onOpenNote={props.onOpenNote} />
              </li>
            )}
          </For>
        </ul>
      }
    >
      <ol class="md-list">
        <For each={props.block.items}>
          {(it) => (
            <li>
              <Inline text={it.s} onOpenNote={props.onOpenNote} />
            </li>
          )}
        </For>
      </ol>
    </Show>
  );
}
