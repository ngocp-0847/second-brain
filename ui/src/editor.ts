// Editor CodeMirror 6 với live-preview kiểu Obsidian:
// - cú pháp Markdown (##, **, `, >) ẩn đi trừ khi con trỏ đứng trên dòng đó
// - [[wikilink]] render gọn (ẩn ngoặc, hiện alias), Ctrl+Click để mở
// - gõ [[ gợi ý note trong vault

import {
  autocompletion,
  completionKeymap,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  defaultHighlightStyle,
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import {
  Compartment,
  EditorState,
  Facet,
  Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { NoteMeta } from "./api";
import { imageFilesOf, isImagePath, resolveImageSrc, saveImageFile } from "./assets";

/** Ba chế độ xem một note, đúng bộ của Obsidian:
 *  - `live`   — Live Preview: cú pháp ẩn trừ dòng đang có con trỏ (mặc định)
 *  - `source` — Source mode: markdown thô, không ẩn gì, không render khối
 *  - `reading`— Reading view: render hết, không sửa được, không có con trỏ */
export type EditorMode = "live" | "source" | "reading";

/** Vùng chọn hiện tại + toạ độ màn hình để neo toolbar nổi ("Sửa bằng AI"). */
export interface SelectionInfo {
  text: string;
  from: number;
  to: number;
  /** Toạ độ viewport (px) của vùng chọn — dùng position: fixed. */
  top: number;
  bottom: number;
  left: number;
}

export interface EditorHandle {
  view: EditorView;
  setContent(text: string): void;
  /** Thay nội dung nhưng GIỮ undo history (mở lại cùng file sau khi agent/tool ngoài
   *  sửa) — Ctrl+Z revert được thay đổi đó, giống Obsidian. */
  updateContent(text: string): void;
  getContent(): string;
  /** Thay một khoảng bằng text mới rồi chọn lại kết quả — transaction nên Ctrl+Z hoàn tác được. */
  replaceRange(from: number, to: number, text: string): void;
  /** Tên note hiện ở đầu trang (inline title); null = không hiện. */
  setTitle(name: string | null): void;
  /** Lưu ngay nếu đang có thay đổi chưa flush. */
  flush(): void;
  /** Đổi theme sáng/tối: reconfigure cờ dark của CM và render lại diagram mermaid. */
  setDark(dark: boolean): void;
  /** Live Preview ↔ Source mode ↔ Reading view. */
  setMode(mode: EditorMode): void;
  getMode(): EditorMode;
  /** Mở panel tìm kiếm của CodeMirror; `replace` = nhảy thẳng vào ô thay thế. */
  openFind(replace?: boolean): void;
  /** Đưa con trỏ về editor (sau khi bấm menu, mở pane…). */
  focus(): void;
  destroy(): void;
}

interface EditorOpts {
  parent: HTMLElement;
  getNotes: () => NoteMeta[];
  onSave: (content: string) => void;
  onOpenLink: (target: string) => void;
  /** Vùng chọn đổi (null = không còn chọn gì) — App dùng để hiện nút "Sửa bằng AI". */
  onSelection?: (sel: SelectionInfo | null) => void;
  /** Vừa lưu một ảnh dán vào vault — App nạp lại cây file cho ảnh hiện ra. */
  onAssetAdded?: (path: string) => void;
  /** Đổi tên note từ inline title (Enter / rời ô). */
  onRenameTitle?: (name: string) => void;
  /** Theme lúc khởi tạo; đổi sau bằng handle.setDark(). Mặc định dark. */
  dark?: boolean;
  /** Chế độ xem lúc khởi tạo; đổi sau bằng handle.setMode(). Mặc định live. */
  mode?: EditorMode;
}

const WIKILINK = /(!?)\[\[([^\[\]]+?)\]\]/g;
const hideMark = Decoration.replace({});

// ---- mermaid: render ```mermaid thành diagram khi con trỏ ở ngoài block ----
// Lib nặng (~1.5MB) nên lazy-load lần đầu gặp block; SVG cache theo code.
let mermaidMod: Promise<typeof import("mermaid")> | null = null;
let mermaidDark = true;
const loadMermaid = () => {
  if (!mermaidMod) {
    mermaidMod = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: mermaidDark ? "dark" : "default" });
      return m;
    });
  }
  return mermaidMod;
};

const mermaidCache = new Map<string, string>(); // code → svg
const MERMAID_CACHE_MAX = 40;

/** Block mermaid (hay bảng) kết thúc ở đúng dòng cuối file thì widget chiếm trọn
 *  dòng cuối và KHÔNG còn vị trí nào phía dưới để đặt con trỏ — CodeMirror sẽ đẩy con
 *  trỏ ngược lên trên block mỗi lần bấm xuống dưới. Thêm một dòng trống để thoát. */
const ensureRoomAfterBlock = (text: string) =>
  /```[ \t]*$|\|[ \t]*$/.test(text) ? `${text}\n` : text;

/** Khoảng của block ```mermaid chứa `pos`, hoặc null. Quét bằng text nên không
 *  phụ thuộc syntax tree (có thể chưa parse xong ngay sau khi dán). */
const mermaidBlockAt = (state: EditorState, pos: number) => {
  const doc = state.doc;
  const cur = doc.lineAt(pos).number;
  let open = 0;
  for (let i = cur; i >= 1; i--) {
    const t = doc.line(i).text;
    if (/^\s*`{3,}\s*mermaid\s*$/i.test(t)) {
      open = i;
      break;
    }
    if (i !== cur && /^\s*`{3,}\s*$/.test(t)) return null; // gặp hàng rào đóng trước
  }
  if (!open) return null;
  for (let i = open + 1; i <= doc.lines; i++) {
    if (/^\s*`{3,}\s*$/.test(doc.line(i).text)) {
      return { from: doc.line(open).from, to: doc.line(i).to };
    }
  }
  return null;
};
let mermaidSeq = 0;
// Đổi khi theme đổi. Widget mang theo giá trị này để eq() báo "khác rồi, dựng lại"
// — nếu không CodeMirror sẽ tái dùng widget cũ và diagram giữ nguyên màu theme cũ.
let mermaidEpoch = 0;

/** Áp theme mới cho mermaid. SVG đã render được nhúng thẳng vào DOM nên phải
 *  bỏ cache và tăng epoch, không thể chỉ đổi config. */
const setMermaidDark = (dark: boolean) => {
  if (dark === mermaidDark) return false;
  mermaidDark = dark;
  mermaidEpoch++;
  const had = mermaidCache.size > 0;
  mermaidCache.clear();
  // initialize() gọi lại được, chỉ ghi đè config — nhưng chỉ khi module đã tải.
  if (mermaidMod) {
    void mermaidMod.then((m) =>
      m.default.initialize({ startOnLoad: false, theme: dark ? "dark" : "default" }),
    );
  }
  return had;
};

class MermaidWidget extends WidgetType {
  readonly epoch = mermaidEpoch;

  constructor(
    readonly code: string,
    readonly editPos: number,
  ) {
    super();
  }

  eq(other: MermaidWidget) {
    return other.code === this.code && other.epoch === this.epoch;
  }

  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-mermaid";

    // Nút chuyển sang sửa code. Vị trí block phải lấy tại thời điểm bấm bằng
    // posAtDOM: widget được tái dùng khi code không đổi (xem eq()), nên toạ độ
    // lưu lúc dựng có thể đã lệch do sửa ở phần trên tài liệu.
    const btn = document.createElement("button");
    btn.className = "cm-mermaid-edit";
    btn.title = "Sửa code mermaid";
    btn.textContent = "<>";
    btn.addEventListener("mousedown", (ev) => ev.preventDefault());
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const doc = view.state.doc;
      const start = doc.lineAt(view.posAtDOM(el));
      let end = start;
      for (let i = start.number + 1; i <= doc.lines; i++) {
        const l = doc.line(i);
        if (/^\s*`{3,}\s*$/.test(l.text)) {
          end = l;
          break;
        }
      }
      // Đặt con trỏ vào dòng đầu của code — chính việc con trỏ nằm trong block
      // là thứ chuyển block về chế độ code.
      view.dispatch({
        selection: { anchor: Math.min(start.to + 1, end.from) },
        scrollIntoView: true,
      });
      view.focus();
    });
    const body = document.createElement("div");
    body.className = "cm-mermaid-body";
    el.append(btn, body);

    const cached = mermaidCache.get(this.code);
    if (cached) {
      body.innerHTML = cached;
      return el;
    }
    body.textContent = "đang render diagram…";
    loadMermaid()
      .then((m) => m.default.render(`mm-${mermaidSeq++}`, this.code))
      .then(({ svg }) => {
        // Sửa trong block mermaid sinh ra một phiên bản code mới mỗi lần con trỏ
        // rời block → cache phình vô hạn nếu không chặn. Giữ FIFO các bản gần đây.
        if (mermaidCache.size >= MERMAID_CACHE_MAX) {
          mermaidCache.delete(mermaidCache.keys().next().value!);
        }
        mermaidCache.set(this.code, svg);
        body.innerHTML = svg;
      })
      .catch((e) => {
        el.className = "cm-mermaid cm-mermaid-error";
        body.textContent = `mermaid: ${String(e?.message ?? e).split("\n")[0]}`;
        // mermaid.render lỗi để lại element rác trong body — dọn đi.
        document.querySelectorAll('[id^="dmm-"], [id^="mm-"]').forEach((x) => {
          if (!el.contains(x) && x.closest(".cm-mermaid") === null) x.remove();
        });
      });
    return el;
  }

  ignoreEvent(e: Event) {
    return e.type !== "click";
  }
}

// ---- bảng GFM: render ```| a | b |``` thành <table> khi con trỏ ở ngoài bảng ----
// Lezer (base markdownLanguage) đã parse ra node `Table`, chỉ thiếu chỗ vẽ. Tự
// tách ô từ text nguồn thay vì đi theo TableCell của cây: cần map từng HÀNG về
// đúng số dòng nguồn để bấm vào là sửa được.

/** Chia một dòng bảng thành các ô, tôn trọng `\|` đã escape. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += s[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

const DELIM_CELL = /^:?-+:?$/;

type Align = "left" | "center" | "right" | null;

const alignOf = (cell: string): Align => {
  const s = cell.trim();
  if (!DELIM_CELL.test(s)) return null;
  const l = s.startsWith(":");
  const r = s.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
};

interface TableModel {
  head: string[];
  /** Hàng thân, cùng thứ tự với dòng nguồn (dòng nguồn của rows[i] = dòng đầu + 2 + i). */
  rows: string[][];
  aligns: Align[];
  /** Text nguồn — dùng cho eq() để CodeMirror biết khi nào phải dựng lại widget. */
  src: string;
}

/** Bảng ở khoảng dòng [first..last], hoặc null nếu không đúng dạng GFM. */
function parseTable(state: EditorState, first: number, last: number): TableModel | null {
  const lines: string[] = [];
  for (let i = first; i <= last; i++) lines.push(state.doc.line(i).text);
  if (lines.length < 2) return null;
  const delim = splitRow(lines[1]);
  if (!delim.every((c) => DELIM_CELL.test(c))) return null;
  const head = splitRow(lines[0]);
  return {
    head,
    rows: lines.slice(2).map(splitRow),
    aligns: head.map((_, i) => alignOf(delim[i] ?? "")),
    src: lines.join("\n"),
  };
}

// Inline trong ô: **đậm**, *nghiêng*, `code`, ~~gạch~~, [[wiki]], link, URL trần.
// Thứ tự quan trọng: `**` phải đứng trước `*`, nếu không `*` nuốt mất một dấu sao.
const INLINE_MD =
  /(\*\*|__)([\s\S]+?)\1|(~~)([\s\S]+?)\3|(`)([^`]+?)\5|(\*|_)([\s\S]+?)\7|\[\[([^\[\]]+?)\]\]|\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')\]]+)/g;

function urlLink(href: string, label: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "cm-md-link";
  a.href = href;
  a.title = href;
  a.textContent = label;
  // Điều hướng thật sẽ đưa cả webview Tauri đi mất — mở cửa sổ ngoài thay vào đó.
  a.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    window.open(href, "_blank");
  });
  return a;
}

/** Render markdown inline vào `host` (DOM thuần — widget không dùng JSX). */
function renderInline(text: string, host: HTMLElement) {
  const wrap = (tag: string, s: string) => {
    const el = document.createElement(tag);
    renderInline(s, el);
    return el;
  };
  let last = 0;
  for (const m of text.matchAll(INLINE_MD)) {
    if (m.index > last) host.append(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== undefined) host.append(wrap("strong", m[2]));
    else if (m[4] !== undefined) host.append(wrap("del", m[4]));
    else if (m[6] !== undefined) {
      const code = document.createElement("code");
      code.textContent = m[6];
      host.append(code);
    } else if (m[8] !== undefined) host.append(wrap("em", m[8]));
    else if (m[9] !== undefined) {
      const inner = m[9];
      const pipe = inner.indexOf("|");
      const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).split("#")[0].trim();
      const el = document.createElement("span");
      el.className = "cm-wikilink"; // Ctrl+Click do domEventHandlers của editor lo
      el.dataset.target = target;
      el.title = `Ctrl+Click để mở "${target}"`;
      el.textContent = pipe >= 0 ? inner.slice(pipe + 1) : inner;
      host.append(el);
    } else if (m[10] !== undefined) host.append(urlLink(m[11], m[10]));
    else host.append(urlLink(m[12], m[12]));
  }
  if (last < text.length) host.append(text.slice(last));
}

class TableWidget extends WidgetType {
  constructor(readonly model: TableModel) {
    super();
  }

  eq(other: TableWidget) {
    return other.model.src === this.model.src;
  }

  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-md-table";
    const table = document.createElement("table");
    const cols = this.model.head.length;

    const addRow = (parent: HTMLElement, cells: string[], tag: "th" | "td", offset: number) => {
      const tr = document.createElement("tr");
      tr.dataset.row = String(offset);
      for (let i = 0; i < cols; i++) {
        const cell = document.createElement(tag);
        const align = this.model.aligns[i];
        if (align) cell.style.textAlign = align;
        renderInline(cells[i] ?? "", cell);
        tr.append(cell);
      }
      parent.append(tr);
    };

    const thead = document.createElement("thead");
    addRow(thead, this.model.head, "th", 0);
    const tbody = document.createElement("tbody");
    // +2: bỏ qua dòng tiêu đề và dòng |---|.
    this.model.rows.forEach((cells, i) => addRow(tbody, cells, "td", i + 2));
    table.append(thead, tbody);
    el.append(table);

    // Bấm vào một hàng → đưa con trỏ vào đúng dòng nguồn, bảng tự chuyển về text
    // thô để sửa. Vị trí phải lấy tại thời điểm bấm bằng posAtDOM: widget được
    // tái dùng khi text không đổi (xem eq()), nên toạ độ lưu lúc dựng có thể lệch.
    el.addEventListener("click", (ev) => {
      if (ev.ctrlKey || ev.metaKey) return; // dành cho Ctrl+Click mở link
      const row = (ev.target as HTMLElement).closest("tr");
      const doc = view.state.doc;
      const start = doc.lineAt(view.posAtDOM(el)).number;
      const line = doc.line(Math.min(start + Number(row?.dataset.row ?? 0), doc.lines));
      view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
      view.focus();
    });
    return el;
  }

  /** Cho mousedown đi qua để handler Ctrl+Click [[wikilink]] của editor chạy được. */
  ignoreEvent(e: Event) {
    return e.type !== "mousedown";
  }
}

// ---- ảnh: dòng chỉ chứa ảnh sẽ render thành <img> ----
// Chỉ nhận dòng CHỈ có ảnh. Ảnh nằm giữa câu vẫn là text thô — thay inline bằng
// widget block sẽ vỡ dòng, mà ảnh chèn giữa đoạn cũng hiếm khi là chủ ý.
//
//   ![alt](https://… "title")   ·   ![alt](assets/a.png)   ·   ![[a.png|chú thích]]
// Hai dạng src: `<…>` cho phép khoảng trắng (path tiếng Việt hay có), còn lại thì không.
const MD_IMAGE =
  /^\s*!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*"|\s+'[^']*')?\s*\)\s*$/;
const EMBED_IMAGE = /^\s*!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]\s*$/;

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-img";

    const fail = (msg: string) => {
      el.className = "cm-img cm-img-error";
      el.textContent = msg;
    };

    const img = document.createElement("img");
    img.alt = this.alt;
    if (this.alt) img.title = this.alt;
    // Ảnh remote hỏng/404 chỉ báo qua sự kiện error — không có nó thì người dùng
    // thấy một khoảng trắng và tưởng app lỗi.
    img.addEventListener("error", () => fail(`không tải được ảnh: ${this.src}`));
    el.append(img);

    resolveImageSrc(this.src)
      .then((s) => {
        img.src = s;
      })
      .catch((e) => fail(`không đọc được ảnh "${this.src}" — ${e}`));
    return el;
  }

  /** Cho mousedown đi qua để bấm vào ảnh là đặt được con trỏ vào dòng mà sửa. */
  ignoreEvent(e: Event) {
    return e.type !== "mousedown";
  }
}

// ---- dán ảnh từ clipboard ----
// Clipboard chứa file ảnh (screenshot, "copy image" trên web, copy file trong
// Explorer) thì text/plain thường rỗng — CodeMirror dán xong chẳng có gì, nhìn
// như app hỏng. Lưu file vào assets/ rồi chèn `![[...]]` để live preview render.
async function insertPastedImages(view: EditorView, files: File[], onAdded?: (p: string) => void) {
  for (const f of files) {
    let rel: string;
    try {
      rel = await saveImageFile(f);
    } catch (err) {
      console.error("lưu ảnh dán vào vault thất bại:", err);
      continue;
    }
    const { from, to } = view.state.selection.main;
    // Ảnh chỉ thành widget khi ĐỨNG MỘT MÌNH trên dòng, và dòng đó không chứa
    // con trỏ (blockPreview giữ text thô ở dòng đang sửa). Nên: xuống dòng nếu
    // trước con trỏ đã có chữ, và kết thúc bằng \n để con trỏ nằm ở dòng sau.
    const lead = view.state.sliceDoc(view.state.doc.lineAt(from).from, from).trim()
      ? "\n"
      : "";
    const insert = `${lead}![[${rel}]]\n`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
      userEvent: "input.paste",
    });
    onAdded?.(rel);
  }
}

// ---- widget thay cả khối (mermaid, bảng) phải đi qua StateField ----
// CodeMirror CHẶN block decoration đến từ ViewPlugin ("Block decorations may not
// be specified via plugins"), nên phần thay cả khối nằm ở state field này;
// ViewPlugin bên dưới chỉ còn lo decoration inline. Field quét cả tài liệu bằng
// text — không dùng syntax tree vì tree chỉ parse tới viewport — và chỉ tính lại
// khi doc đổi hoặc tập dòng có con trỏ đổi.

interface BlockPreview {
  deco: DecorationSet;
  /** Khoảng đã bị thay — decoration inline KHÔNG được chồng vào đây. */
  spans: { from: number; to: number }[];
}

const FENCE = /^\s*(`{3,}|~{3,})\s*(\S*)/;

/** Bật ở Reading view. Decoration hỏi facet này thay vì một biến module — mỗi
 *  pane là một EditorState riêng nên chế độ phải nằm TRONG state. */
const readingFacet = Facet.define<boolean, boolean>({
  combine: (vs) => vs.length > 0 && vs[0],
});

/** Tập dòng đang có con trỏ — khối chứa con trỏ phải hiện text thô để sửa.
 *  Reading view không sửa được nên coi như không dòng nào active: render sạch. */
const activeLineSet = (state: EditorState) => {
  const set = new Set<number>();
  if (state.facet(readingFacet)) return set;
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set;
};

/** Dòng `|---|:--:|` khớp số cột với dòng tiêu đề → đúng là bảng GFM. */
const isDelimiterRow = (delim: string, header: string) => {
  if (!delim.includes("-") || !delim.includes("|")) return false;
  const cells = splitRow(delim);
  return cells.length === splitRow(header).length && cells.every((c) => DELIM_CELL.test(c));
};

function buildBlocks(state: EditorState): BlockPreview {
  const doc = state.doc;
  const active = activeLineSet(state);
  const decos: Range<Decoration>[] = [];
  const spans: { from: number; to: number }[] = [];

  const add = (first: number, last: number, widget: WidgetType) => {
    // Con trỏ nằm trong khối thì PHẢI hiện text thô: Decoration.replace
    // block-level không được bao con trỏ, nếu không CodeMirror đẩy con trỏ ra
    // và thao tác gõ loạn.
    for (let i = first; i <= last; i++) if (active.has(i)) return;
    const from = doc.line(first).from;
    const to = doc.line(last).to;
    decos.push(Decoration.replace({ widget, block: true }).range(from, to));
    spans.push({ from, to });
  };

  let i = 1;
  while (i <= doc.lines) {
    const text = doc.line(i).text;
    const fence = text.match(FENCE);
    if (fence) {
      const close = new RegExp("^\\s*" + fence[1][0] + "{" + fence[1].length + ",}\\s*$");
      let last = doc.lines;
      for (let j = i + 1; j <= doc.lines; j++) {
        if (close.test(doc.line(j).text)) {
          last = j;
          break;
        }
      }
      // ```mermaid → thay cả block bằng diagram. Cú pháp chuẩn Obsidian, nội
      // dung file .md không đổi gì. Dán xong thì onPaste tự đưa con trỏ ra sau
      // block để diagram hiện ngay.
      if (fence[2].toLowerCase() === "mermaid" && last > i + 1) {
        const code = state.sliceDoc(doc.line(i + 1).from, doc.line(last - 1).to);
        if (code.trim()) add(i, last, new MermaidWidget(code, doc.line(i).to));
      }
      i = last + 1;
      continue;
    }
    // Dòng tiêu đề + dòng |---| → bảng. Thân bảng chạy tới dòng trống, dòng
    // không còn dấu | , hoặc một hàng rào code.
    if (i < doc.lines && text.includes("|") && isDelimiterRow(doc.line(i + 1).text, text)) {
      let last = i + 1;
      while (last < doc.lines) {
        const next = doc.line(last + 1).text;
        if (!next.trim() || !next.includes("|") || FENCE.test(next)) break;
        last++;
      }
      const model = parseTable(state, i, last);
      if (model) add(i, last, new TableWidget(model));
      i = last + 1;
      continue;
    }
    const md = text.match(MD_IMAGE);
    if (md) {
      add(i, i, new ImageWidget((md[2] ?? md[3]).trim(), md[1]));
      i++;
      continue;
    }
    // `![[note]]` là nhúng note, không phải ảnh — chỉ nhận khi đuôi file là ảnh.
    const embed = text.match(EMBED_IMAGE);
    if (embed && isImagePath(embed[1])) {
      add(i, i, new ImageWidget(embed[1].trim(), embed[2] ?? ""));
      i++;
      continue;
    }
    i++;
  }
  return { deco: Decoration.set(decos, true), spans };
}

/** Khóa "tập dòng đang có con trỏ" — thứ duy nhất của selection đổi decoration. */
const activeKey = (state: EditorState) =>
  state.selection.ranges
    .map((r) => `${state.doc.lineAt(r.from).number}-${state.doc.lineAt(r.to).number}`)
    .join(",");

/** activeKey + chế độ xem: đổi sang Reading view cũng phải vẽ lại decoration. */
const stateKey = (state: EditorState) =>
  `${state.facet(readingFacet) ? "r" : "e"}:${activeKey(state)}`;

// ---- inline title: tên note hiện ngay đầu trang như Obsidian ----
// Không nằm trong file .md — nó là tên FILE, vẽ thành widget ở đầu tài liệu.
// Sửa tại chỗ rồi Enter = đổi tên note (App lo rewrite wikilink).

/** Tên note đang mở; null = không hiện inline title (card canvas, chưa mở note). */
const titleEffect = StateEffect.define<string | null>();

const titleState = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(titleEffect)) return e.value;
    return value;
  },
});

class TitleWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly onRename?: (name: string) => void,
  ) {
    super();
  }

  eq(other: TitleWidget) {
    return other.name === this.name;
  }

  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-inline-title";
    el.textContent = this.name;
    if (!this.onRename) return el;

    el.contentEditable = "true";
    el.spellcheck = false;
    const commit = () => {
      const next = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      // Xoá trắng rồi rời ô → trả lại tên cũ, đừng đổi tên file thành rỗng.
      if (!next || next === this.name) {
        el.textContent = this.name;
        return;
      }
      this.onRename!(next);
    };
    el.addEventListener("keydown", (e) => {
      // Title là MỘT dòng: Enter xác nhận rồi nhường focus cho nội dung.
      if (e.key === "Enter") {
        e.preventDefault();
        el.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        el.textContent = this.name;
        el.blur();
      }
    });
    el.addEventListener("blur", commit);
    // Dán từ web hay kéo chữ vào đây đều mang theo HTML — chỉ giữ phần chữ.
    el.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain")?.replace(/\s+/g, " ");
      if (text) document.execCommand("insertText", false, text);
    });
    return el;
  }

  /** Widget tự lo mọi sự kiện — để CodeMirror xử lý thì gõ vào đây sẽ loạn. */
  ignoreEvent() {
    return true;
  }

  /** Ô này contentEditable nằm trong vùng soạn thảo của CodeMirror: gõ vào đây
   *  sinh DOM mutation mà CM tưởng là nội dung đổi rồi dựng lại widget — chữ
   *  vừa gõ biến mất. Bảo CM kệ mọi thay đổi bên trong. */
  ignoreMutation() {
    return true;
  }
}

/** Widget nằm TRƯỚC dòng đầu (side < 0) nên không nuốt mất nội dung nào. */
const titleDeco = (onRename?: (name: string) => void) => {
  const build = (name: string | null) =>
    name === null
      ? Decoration.none
      : Decoration.set([
          Decoration.widget({
            widget: new TitleWidget(name, onRename),
            side: -1,
            block: true,
          }).range(0),
        ]);
  return StateField.define<DecorationSet>({
    // setState dựng state mới với title đã seed — dựng decoration ngay ở đây,
    // nếu chỉ làm trong update() thì đổi note xong title trống tới lần gõ đầu.
    create: (state) => build(state.field(titleState)),
    update(value, tr) {
      const name = tr.state.field(titleState);
      if (name === tr.startState.field(titleState)) return value.map(tr.changes);
      return build(name);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
};

const blockPreview = StateField.define<BlockPreview>({
  create: buildBlocks,
  update(value, tr) {
    // Gõ trong cùng một dòng: selection đổi liên tục nhưng tập dòng active không
    // đổi → khối y hệt, khỏi quét lại cả tài liệu mỗi lần nhấn phím.
    // Đổi sang/khỏi Reading view thì không có gì "đổi" theo nghĩa trên nhưng
    // tập dòng active bị vô hiệu hoá → phải dựng lại, nếu không khối cạnh con
    // trỏ vẫn kẹt ở dạng text thô.
    if (
      !tr.docChanged &&
      activeKey(tr.startState) === activeKey(tr.state) &&
      tr.startState.facet(readingFacet) === tr.state.facet(readingFacet)
    )
      return value;
    return buildBlocks(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** Decoration inline: ẩn dấu cú pháp và render [[wikilink]] gọn. Khối đã bị
 *  blockPreview thay bằng widget thì bỏ qua — không chồng lên được. */
function buildLivePreview(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const state = view.state;
  const activeLines = activeLineSet(state);
  // Source mode gỡ blockPreview khỏi cấu hình → không có field để đọc.
  const spans = state.field(blockPreview, false)?.spans ?? [];
  const inReplaced = (a: number, b: number) => spans.some((r) => a < r.to && b > r.from);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (
          node.name !== "HeaderMark" &&
          node.name !== "EmphasisMark" &&
          node.name !== "CodeMark" &&
          node.name !== "QuoteMark"
        )
          return;
        if (activeLines.has(state.doc.lineAt(node.from).number)) return;
        if (inReplaced(node.from, node.to)) return;
        let end = node.to;
        if (node.name === "HeaderMark" && state.doc.sliceString(end, end + 1) === " ") end++;
        // CodeMark của fenced block (```): giữ nguyên, chỉ ẩn inline `
        if (node.name === "CodeMark" && node.to - node.from > 1) return;
        decos.push(hideMark.range(node.from, end));
      },
    });

    const text = state.sliceDoc(from, to);
    for (const m of text.matchAll(WIKILINK)) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (inReplaced(start, end)) continue; // widget tự render wikilink của nó
      const line = state.doc.lineAt(start).number;
      const inner = m[2];
      const pipe = inner.indexOf("|");
      const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).split("#")[0].trim();
      const linkMark = Decoration.mark({
        class: "cm-wikilink",
        attributes: { "data-target": target, title: `Ctrl+Click để mở "${target}"` },
      });
      if (activeLines.has(line)) {
        decos.push(linkMark.range(start, end));
      } else {
        const innerStart = start + m[1].length + 2;
        decos.push(hideMark.range(start, innerStart));
        const visFrom = pipe >= 0 ? innerStart + pipe + 1 : innerStart;
        if (pipe >= 0) decos.push(hideMark.range(innerStart, visFrom));
        decos.push(linkMark.range(visFrom, end - 2));
        decos.push(hideMark.range(end - 2, end));
      }
    }
  }
  return Decoration.set(decos, true);
}


const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    lastActive: string;
    constructor(view: EditorView) {
      this.decorations = buildLivePreview(view);
      this.lastActive = stateKey(view.state);
    }
    update(u: ViewUpdate) {
      // Gõ trong cùng một dòng thì selection đổi liên tục nhưng tập dòng active
      // không đổi → decoration y hệt. Bỏ qua để khỏi iterate lại syntaxTree mỗi
      // lần nhấn phím (rất tốn khi note có fenced block lớn).
      const active = stateKey(u.view.state);
      if (!u.docChanged && !u.viewportChanged && active === this.lastActive) return;
      this.lastActive = active;
      this.decorations = buildLivePreview(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// CodeMirror sinh CSS thật từ hai object dưới đây, nên giá trị "var(--token)"
// hoạt động bình thường và tự đổi theo theme mà không cần dựng lại state.
// Riêng cờ { dark } thì không — nó quyết định class cm-theme-dark/light và ảnh
// hưởng style nội bộ của CM, nên phải reconfigure qua Compartment.
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.7em", fontWeight: "700", color: "var(--fg-strong)" },
  { tag: tags.heading2, fontSize: "1.45em", fontWeight: "700", color: "var(--fg-strong)" },
  { tag: tags.heading3, fontSize: "1.25em", fontWeight: "600", color: "var(--fg-strong)" },
  { tag: tags.heading4, fontSize: "1.1em", fontWeight: "600", color: "var(--fg-strong)" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--fg-muted)" },
  { tag: tags.monospace, fontFamily: "'Cascadia Code', Consolas, monospace", color: "var(--code)" },
  { tag: tags.quote, color: "var(--fg-muted)", fontStyle: "italic" },
  { tag: tags.link, color: "var(--link)" },
  { tag: tags.url, color: "var(--fg-faint)" },
  { tag: tags.processingInstruction, color: "var(--fg-faint)" },
  { tag: tags.contentSeparator, color: "var(--fg-faint)" },
  { tag: tags.list, color: "var(--fg)" },
]);

const themeStyles = {
  "&": { height: "100%", fontSize: "15.5px", backgroundColor: "transparent" },
  ".cm-scroller": {
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    lineHeight: "1.65",
    padding: "1.2rem 0",
  },
  ".cm-content": { maxWidth: "46rem", margin: "0 auto", caretColor: "var(--fg)" },
  // Cùng cỡ với H1 trong nội dung (mdHighlight heading1 = 1.7em) để tiêu đề
  // trang và H1 đầu note không đá nhau về thị giác.
  ".cm-inline-title": {
    padding: "0 1.5rem",
    margin: "0.2rem 0 0.6rem",
    fontSize: "1.7em",
    fontWeight: "700",
    lineHeight: "1.25",
    color: "var(--fg-strong)",
    outline: "none",
  },
  ".cm-inline-title:empty::before": {
    content: '"Không tên"',
    color: "var(--fg-faint)",
  },
  ".cm-line": { padding: "0 1.5rem" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-activeLine": { backgroundColor: "var(--line-active)" },
  ".cm-wikilink": { color: "var(--accent)", cursor: "pointer" },
  ".cm-wikilink:hover": { textDecoration: "underline" },
  ".cm-mermaid": {
    position: "relative",
    maxWidth: "46rem",
    margin: "0.4rem auto",
    padding: "0.8rem 1rem",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "10px",
    color: "var(--fg-muted)",
  },
  ".cm-mermaid-body": {
    display: "flex",
    justifyContent: "center",
    overflow: "auto",
  },
  ".cm-mermaid svg": { maxWidth: "100%", height: "auto" },
  // Nút <>: mờ cho tới khi rê vào block, để diagram không bị vướng mắt.
  ".cm-mermaid-edit": {
    position: "absolute",
    top: "6px",
    right: "6px",
    zIndex: "1",
    padding: "2px 7px",
    background: "var(--bg-side)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    color: "var(--fg-muted)",
    font: "inherit",
    fontFamily: "'Cascadia Code', Consolas, monospace",
    fontSize: "12px",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity 0.12s",
  },
  ".cm-mermaid:hover .cm-mermaid-edit": { opacity: "1" },
  ".cm-mermaid-edit:hover": { color: "var(--accent-strong)", borderColor: "var(--accent-border)" },
  ".cm-mermaid-error": {
    color: "var(--danger)",
    fontFamily: "Consolas, monospace",
    fontSize: "13px",
  },
  // Ảnh đã render. Cùng bề ngang với mermaid/bảng để cả trang thẳng hàng.
  ".cm-img": {
    maxWidth: "46rem",
    margin: "0.5rem auto",
    padding: "0 1.5rem",
  },
  ".cm-img img": {
    display: "block",
    maxWidth: "100%",
    height: "auto",
    borderRadius: "8px",
  },
  ".cm-img-error": {
    color: "var(--danger)",
    fontFamily: "Consolas, monospace",
    fontSize: "13px",
    wordBreak: "break-all",
  },
  // Bảng markdown đã render. Bọc trong div cuộn ngang để bảng rộng không phá layout.
  ".cm-md-table": {
    maxWidth: "46rem",
    margin: "0.5rem auto",
    padding: "0 1.5rem",
    overflowX: "auto",
    cursor: "text",
  },
  ".cm-md-table table": {
    borderCollapse: "collapse",
    width: "100%",
    fontSize: "0.95em",
    lineHeight: "1.5",
  },
  ".cm-md-table th, .cm-md-table td": {
    border: "1px solid var(--border)",
    padding: "0.35rem 0.6rem",
    textAlign: "left",
    verticalAlign: "top",
  },
  ".cm-md-table th": {
    background: "var(--bg-panel)",
    color: "var(--fg-strong)",
    fontWeight: "600",
  },
  ".cm-md-table tbody tr:hover": { background: "var(--line-active)" },
  ".cm-md-table code": {
    fontFamily: "'Cascadia Code', Consolas, monospace",
    fontSize: "0.9em",
    color: "var(--code)",
  },
  ".cm-md-table a.cm-md-link": { color: "var(--link)", cursor: "pointer" },
  ".cm-md-table .cm-wikilink": { color: "var(--accent)", cursor: "pointer" },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border-card)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--selection)" },

  // Panel Tìm/Thay thế (Ctrl+F, Ctrl+H). Style mặc định của CodeMirror là nền
  // sáng cứng — phải phủ bằng token, nếu không theme tối nhìn như lỗi.
  ".cm-panels": {
    backgroundColor: "var(--bg-panel)",
    color: "var(--fg)",
    borderColor: "var(--border)",
  },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": { padding: "6px 8px", fontFamily: "inherit", fontSize: "12.5px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
    fontFamily: "inherit",
    fontSize: "12.5px",
  },
  ".cm-panel.cm-search input[type=text]": {
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
    border: "1px solid var(--border-card)",
    borderRadius: "4px",
    padding: "3px 6px",
  },
  ".cm-panel.cm-search button:not([name=close])": {
    backgroundColor: "var(--bg)",
    backgroundImage: "none",
    color: "var(--fg)",
    border: "1px solid var(--border-card)",
    borderRadius: "4px",
    padding: "2px 8px",
    cursor: "pointer",
  },
  ".cm-panel.cm-search button[name=close]": { color: "var(--fg-muted)", cursor: "pointer" },
  ".cm-searchMatch": { backgroundColor: "var(--accent-bg)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent-bg-hover)" },

  // Reading view: không sửa được nên không có con trỏ, cũng không tô dòng hiện tại.
  "&.cm-reading .cm-cursor, &.cm-reading .cm-cursorLayer": { display: "none" },
  "&.cm-reading .cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-reading .cm-content": { caretColor: "transparent" },
};

const makeTheme = (dark: boolean) => EditorView.theme(themeStyles, { dark });
const themeConf = new Compartment();
const modeConf = new Compartment();

/** Extension của từng chế độ xem. Đi qua Compartment nên đổi chế độ KHÔNG dựng
 *  lại state — undo history và vị trí cuộn giữ nguyên. */
const modeExts = (m: EditorMode) =>
  m === "source"
    ? []
    : m === "reading"
      ? [
          blockPreview,
          livePreview,
          readingFacet.of(true),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.editorAttributes.of({ class: "cm-reading" }),
        ]
      : [blockPreview, livePreview];

export function createEditor(opts: EditorOpts): EditorHandle {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let suppress = false; // đang setContent, đừng autosave
  let dark = opts.dark ?? true;
  let mode: EditorMode = opts.mode ?? "live";
  mermaidDark = dark; // trước khi mermaid được lazy-load lần đầu

  const flush = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    if (dirty) {
      dirty = false;
      opts.onSave(view.state.doc.toString());
    }
  };

  const wikiComplete = (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\[\[([^\[\]|#]*)$/);
    if (!m) return null;
    const seen = new Set<string>();
    const options = [];
    for (const n of opts.getNotes()) {
      const stem = n.path.replace(/\.md$/i, "").split("/").pop()!;
      if (seen.has(stem.toLowerCase())) continue;
      seen.add(stem.toLowerCase());
      options.push({
        label: stem,
        detail: n.title !== stem ? n.title : n.path,
        apply: stem + "]]",
        type: "text",
      });
    }
    return { from: m.from + 2, options, validFor: /^[^\[\]|#]*$/ };
  };

  /** Vùng chọn chính, kèm toạ độ (bỏ qua chọn rỗng / chỉ toàn khoảng trắng). */
  const readSelection = (v: EditorView): SelectionInfo | null => {
    const r = v.state.selection.main;
    if (r.empty) return null;
    const text = v.state.sliceDoc(r.from, r.to);
    if (!text.trim()) return null;
    const a = v.coordsAtPos(r.from);
    const b = v.coordsAtPos(r.to);
    if (!a || !b) return null;
    // Cuộn ra khỏi tầm nhìn → coi như không có vùng chọn, khỏi để toolbar lơ lửng sai chỗ.
    const box = v.scrollDOM.getBoundingClientRect();
    if (b.bottom < box.top + 4 || a.top > box.bottom - 4) return null;
    return {
      text,
      from: r.from,
      to: r.to,
      top: Math.min(a.top, b.top),
      bottom: Math.max(a.bottom, b.bottom),
      // Neo vào đầu dòng cuối cùng của vùng chọn cho khỏi lệch ra ngoài editor.
      left: b.top > a.top ? Math.min(a.left, b.left) : a.left,
    };
  };

  // Dọn host trước khi gắn: nếu createEditor bị gọi lại trên cùng một div (HMR
  // re-mount App chẳng hạn) mà không dọn thì sẽ có HAI EditorView chồng nhau —
  // hiện hai con trỏ, gõ ra ký tự thừa, layout loạn.
  opts.parent.replaceChildren();
  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({ doc: "" }),
  });

  // Tên note của tab đang mở — setState dựng state MỚI nên phải seed lại,
  // nếu không đổi note một cái là inline title biến mất.
  let title: string | null = null;

  const makeState = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        highlightSpecialChars(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(mdHighlight),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        modeConf.of(modeExts(mode)),
        titleState.init(() => title),
        titleDeco(opts.onRenameTitle),
        themeConf.of(makeTheme(dark)),
        autocompletion({ override: [wikiComplete], activateOnTyping: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !suppress) {
            dirty = true;
            if (saveTimer) clearTimeout(saveTimer);
            saveTimer = setTimeout(flush, 800);
          }
          if (opts.onSelection && (u.selectionSet || u.docChanged || u.geometryChanged))
            opts.onSelection(readSelection(u.view));
        }),
        EditorView.domEventHandlers({
          // Ảnh trong clipboard → lưu vào vault rồi chèn `![[...]]`.
          // Còn lại là dán thường: dán block mermaid xong con trỏ nằm trong
          // block nên nó hiện code thô — đưa con trỏ ra ngay sau block để
          // diagram render luôn.
          paste(e, view) {
            const imgs = imageFilesOf(e.clipboardData);
            if (imgs.length) {
              e.preventDefault();
              void insertPastedImages(view, imgs, opts.onAssetAdded);
              return true;
            }
            queueMicrotask(() => {
              const blk = mermaidBlockAt(view.state, view.state.selection.main.head);
              if (!blk) return; // con trỏ đã ở ngoài block
              // blk.to là CUỐI dòng hàng rào đóng — vẫn nằm trong khoảng bị
              // replace. Phải sang hẳn dòng sau; block dán ở cuối file thì
              // chưa có dòng nào ở sau, tự thêm một dòng trống.
              const len = view.state.doc.length;
              if (blk.to >= len) {
                view.dispatch({
                  changes: { from: len, insert: "\n" },
                  selection: { anchor: len + 1 },
                });
              } else {
                view.dispatch({ selection: { anchor: blk.to + 1 } });
              }
            });
            return false;
          },
          mousedown(e) {
            if (!(e.ctrlKey || e.metaKey)) return false;
            const el = (e.target as HTMLElement).closest(".cm-wikilink");
            const target = el?.getAttribute("data-target");
            if (target) {
              e.preventDefault();
              opts.onOpenLink(target);
              return true;
            }
            return false;
          },
        }),
      ],
    });

  // Cuộn không tạo transaction → phải bám riêng để toolbar nổi đi theo vùng chọn.
  const onScroll = opts.onSelection
    ? () => opts.onSelection!(readSelection(view))
    : null;
  if (onScroll) view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });

  return {
    view,
    setContent(text) {
      suppress = true;
      view.setState(makeState(ensureRoomAfterBlock(text)));
      suppress = false;
      dirty = false;
      // setState không gọi update listener → tự dọn vùng chọn của note trước.
      opts.onSelection?.(null);
    },
    updateContent(text) {
      if (text === view.state.doc.toString()) return;
      suppress = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      suppress = false;
      dirty = false;
    },
    getContent: () => view.state.doc.toString(),
    replaceRange(from, to, text) {
      const end = Math.min(to, view.state.doc.length);
      view.dispatch({
        changes: { from, to: end, insert: text },
        selection: { anchor: from, head: from + text.length },
        scrollIntoView: true,
      });
      view.focus();
      flush();
    },
    setTitle(name) {
      if (name === title) return;
      title = name;
      view.dispatch({ effects: titleEffect.of(name) });
    },
    flush,
    setDark(next) {
      if (next === dark) return;
      dark = next;
      // Màu đi qua var() nên đổi ngay theo CSS; chỉ cờ dark cần reconfigure.
      view.dispatch({ effects: themeConf.reconfigure(makeTheme(dark)) });
      // Diagram mermaid là SVG đã nhúng sẵn, không ăn CSS variable → dựng lại
      // state để widget render lại. Chỉ làm khi note thật sự có diagram.
      if (setMermaidDark(dark)) {
        const sel = view.state.selection;
        const scroll = view.scrollDOM.scrollTop;
        suppress = true;
        view.setState(makeState(view.state.doc.toString()));
        view.dispatch({ selection: sel });
        view.scrollDOM.scrollTop = scroll;
        suppress = false;
      }
    },
    setMode(next) {
      if (next === mode) return;
      // Rời Reading view thì editor mới nhận được lệnh sửa lại — nhưng phải
      // flush trước khi VÀO Reading view, chỗ khác không còn cách lưu.
      if (next === "reading") flush();
      mode = next;
      view.dispatch({ effects: modeConf.reconfigure(modeExts(mode)) });
    },
    getMode: () => mode,
    openFind(replace) {
      openSearchPanel(view);
      // Panel dựng xong ở cuối transaction; đợi một nhịp rồi mới trỏ vào ô.
      queueMicrotask(() => {
        const sel = replace ? 'input[name="replace"]' : 'input[name="search"]';
        const input = view.dom.querySelector<HTMLInputElement>(sel);
        input?.focus();
        input?.select();
      });
    },
    focus: () => view.focus(),
    destroy() {
      if (saveTimer) clearTimeout(saveTimer);
      if (onScroll) view.scrollDOM.removeEventListener("scroll", onScroll);
      view.destroy();
    },
  };
}
