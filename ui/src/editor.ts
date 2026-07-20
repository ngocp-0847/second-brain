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
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, Range } from "@codemirror/state";
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

export interface EditorHandle {
  view: EditorView;
  setContent(text: string): void;
  getContent(): string;
  /** Lưu ngay nếu đang có thay đổi chưa flush. */
  flush(): void;
  destroy(): void;
}

interface EditorOpts {
  parent: HTMLElement;
  getNotes: () => NoteMeta[];
  onSave: (content: string) => void;
  onOpenLink: (target: string) => void;
}

const WIKILINK = /(!?)\[\[([^\[\]]+?)\]\]/g;
const hideMark = Decoration.replace({});

// ---- mermaid: render ```mermaid thành diagram khi con trỏ ở ngoài block ----
// Lib nặng (~1.5MB) nên lazy-load lần đầu gặp block; SVG cache theo code.
let mermaidMod: Promise<typeof import("mermaid")> | null = null;
const loadMermaid = () => {
  if (!mermaidMod) {
    mermaidMod = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: "dark", darkMode: true });
      return m;
    });
  }
  return mermaidMod;
};

const mermaidCache = new Map<string, string>(); // code → svg
let mermaidSeq = 0;

class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly editPos: number,
  ) {
    super();
  }

  eq(other: MermaidWidget) {
    return other.code === this.code;
  }

  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-mermaid";
    el.title = "Click để sửa code mermaid";
    el.addEventListener("click", () => {
      view.dispatch({ selection: { anchor: this.editPos }, scrollIntoView: true });
      view.focus();
    });
    const cached = mermaidCache.get(this.code);
    if (cached) {
      el.innerHTML = cached;
      return el;
    }
    el.textContent = "⏳ đang render diagram…";
    loadMermaid()
      .then((m) => m.default.render(`mm-${mermaidSeq++}`, this.code))
      .then(({ svg }) => {
        mermaidCache.set(this.code, svg);
        el.innerHTML = svg;
      })
      .catch((e) => {
        el.innerHTML = "";
        el.className = "cm-mermaid cm-mermaid-error";
        el.textContent = `⚠ mermaid: ${String(e?.message ?? e).split("\n")[0]}`;
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

function buildLivePreview(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const state = view.state;

  const activeLines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) activeLines.add(i);
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        // ```mermaid → thay cả block bằng diagram (trừ khi đang sửa bên trong).
        // Cú pháp chuẩn Obsidian — nội dung file .md không đổi gì.
        if (node.name === "FencedCode") {
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          const lang = first.text.replace(/^\s*`+/, "").trim().toLowerCase();
          if (lang !== "mermaid") return;
          for (let i = first.number; i <= last.number; i++) {
            if (activeLines.has(i)) return false;
          }
          const code =
            last.number > first.number + 1
              ? state.sliceDoc(state.doc.line(first.number + 1).from, state.doc.line(last.number - 1).to)
              : "";
          if (code.trim()) {
            decos.push(
              Decoration.replace({
                widget: new MermaidWidget(code, first.to),
                block: true,
              }).range(first.from, last.to),
            );
          }
          return false;
        }
        if (
          node.name !== "HeaderMark" &&
          node.name !== "EmphasisMark" &&
          node.name !== "CodeMark" &&
          node.name !== "QuoteMark"
        )
          return;
        if (activeLines.has(state.doc.lineAt(node.from).number)) return;
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
    constructor(view: EditorView) {
      this.decorations = buildLivePreview(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged)
        this.decorations = buildLivePreview(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.7em", fontWeight: "700", color: "#e8eaf2" },
  { tag: tags.heading2, fontSize: "1.45em", fontWeight: "700", color: "#e8eaf2" },
  { tag: tags.heading3, fontSize: "1.25em", fontWeight: "600", color: "#e8eaf2" },
  { tag: tags.heading4, fontSize: "1.1em", fontWeight: "600", color: "#e8eaf2" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "#8b93a7" },
  { tag: tags.monospace, fontFamily: "'Cascadia Code', Consolas, monospace", color: "#e0b06a" },
  { tag: tags.quote, color: "#9aa3b8", fontStyle: "italic" },
  { tag: tags.link, color: "#8fa8ff" },
  { tag: tags.url, color: "#5f6b85" },
  { tag: tags.processingInstruction, color: "#5f6b85" },
  { tag: tags.contentSeparator, color: "#5f6b85" },
  { tag: tags.list, color: "#c7cddd" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", fontSize: "15.5px", backgroundColor: "transparent" },
    ".cm-scroller": {
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      lineHeight: "1.65",
      padding: "1.2rem 0",
    },
    ".cm-content": { maxWidth: "46rem", margin: "0 auto", caretColor: "#c7cddd" },
    ".cm-line": { padding: "0 1.5rem" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "#c7cddd" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#3b4261 !important",
    },
    ".cm-activeLine": { backgroundColor: "#ffffff08" },
    ".cm-wikilink": { color: "#a48fff", cursor: "pointer" },
    ".cm-wikilink:hover": { textDecoration: "underline" },
    ".cm-mermaid": {
      display: "flex",
      justifyContent: "center",
      maxWidth: "46rem",
      margin: "0.4rem auto",
      padding: "0.8rem 1rem",
      background: "#1e2130",
      border: "1px solid #2a2f42",
      borderRadius: "10px",
      cursor: "pointer",
      color: "#8b93a7",
      overflow: "auto",
    },
    ".cm-mermaid svg": { maxWidth: "100%", height: "auto" },
    ".cm-mermaid-error": { color: "#e0876a", fontFamily: "Consolas, monospace", fontSize: "13px" },
    ".cm-tooltip.cm-tooltip-autocomplete": {
      backgroundColor: "#1e2130",
      border: "1px solid #333a52",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "#3b4261" },
  },
  { dark: true },
);

export function createEditor(opts: EditorOpts): EditorHandle {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let suppress = false; // đang setContent, đừng autosave

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

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({ doc: "" }),
  });

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
        livePreview,
        theme,
        autocompletion({ override: [wikiComplete], activateOnTyping: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !suppress) {
            dirty = true;
            if (saveTimer) clearTimeout(saveTimer);
            saveTimer = setTimeout(flush, 800);
          }
        }),
        EditorView.domEventHandlers({
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

  return {
    view,
    setContent(text) {
      suppress = true;
      view.setState(makeState(text));
      suppress = false;
      dirty = false;
    },
    getContent: () => view.state.doc.toString(),
    flush,
    destroy() {
      if (saveTimer) clearTimeout(saveTimer);
      view.destroy();
    },
  };
}
