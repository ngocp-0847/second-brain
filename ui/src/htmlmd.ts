// Dán từ Slack, trình duyệt, Google Docs/Sheets: clipboard có cả text/html lẫn
// text/plain. Bản plain đã mất cấu trúc — Slack biến list thành "•  …" và
// "◦  …", in đậm/link mất sạch — nên dán thẳng ra file thì nhìn như rác.
// Obsidian đổi phần HTML sang Markdown lúc dán ("Convert pasted HTML to
// Markdown"); làm y như vậy ở đây, tự viết bằng DOMParser cho khỏi kéo thêm dep.

const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV",
  "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE",
  "TABLE", "HR", "FIGURE", "DL", "DT", "DD", "ADDRESS", "DETAILS", "SUMMARY",
]);
const BLOCK_SELECTOR = [...BLOCK_TAGS].join(",");
const SKIP_TAGS =new Set(["STYLE", "SCRIPT", "META", "TITLE", "HEAD", "NOSCRIPT", "TEMPLATE"]);

/** Có thẻ mang nghĩa Markdown. HTML không có thẻ nào kiểu này (VS Code chỉ là
 *  div + span tô màu, giữ thụt lề bằng white-space: pre) thì dán text thường —
 *  chuyển sẽ làm hỏng thụt lề của code. */
const MEANINGFUL =
  "ul,ol,li,h1,h2,h3,h4,h5,h6,blockquote,pre,table,b,strong,em,i,s,del,strike,a[href],img,hr,code";

interface Block {
  md: string;
  /** List liền nhau phải nối bằng MỘT xuống dòng — cách dòng trống là thành
   *  "loose list" (mỗi mục giãn như đoạn văn). Slack còn tách từng cấp thụt lề
   *  thành một <ul> riêng nên trường hợp này gặp thường xuyên. */
  list?: boolean;
}

const isEl = (n: Node): n is HTMLElement => n.nodeType === Node.ELEMENT_NODE;

/** Google Docs bọc CẢ nội dung trong <b style="font-weight:normal"> — không phải đậm. */
const isBold = (el: HTMLElement) => {
  const w = el.style.fontWeight;
  if (el.tagName === "B" || el.tagName === "STRONG") return !(w === "normal" || w === "400");
  return w === "bold" || Number(w) >= 600;
};
const isItalic = (el: HTMLElement) =>
  el.tagName === "EM" || el.tagName === "I" || el.style.fontStyle === "italic";
const isStrike = (el: HTMLElement) =>
  el.tagName === "S" || el.tagName === "DEL" || el.tagName === "STRIKE" ||
  el.style.textDecoration.includes("line-through");

/** `**…**` phải ôm sát chữ: `** chữ **` không còn là đậm trong Markdown. */
const wrapInline = (s: string, mark: string) => {
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
};

function inline(node: Node, inPre = false): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent ?? "").replace(/\u00a0/g, " ");
    return inPre ? t : t.replace(/\s+/g, " ");
  }
  if (!isEl(node) || SKIP_TAGS.has(node.tagName)) return "";
  const el = node;
  const tag = el.tagName;
  // Slack đánh dấu chỗ xuống đoạn bằng span rỗng thay vì <p>.
  if (el.dataset.stringifyType === "paragraph-break") return "\n\n";
  if (tag === "BR") return "\n";
  if (tag === "IMG") {
    // Emoji Slack: <img data-stringify-text=":tada:"> — giữ mã emoji.
    const txt = el.dataset.stringifyText;
    if (txt) return txt;
    const src = el.getAttribute("src") ?? "";
    const alt = el.getAttribute("alt") ?? "";
    return /^https?:/i.test(src) ? `![${alt}](${src})` : alt;
  }
  if (tag === "CODE" && !inPre) {
    const code = el.textContent ?? "";
    const fence = code.includes("`") ? "``" : "`";
    return code ? `${fence}${code}${fence}` : "";
  }
  let s = "";
  for (const c of el.childNodes) s += inline(c, inPre);
  if (tag === "A") {
    const href = el.getAttribute("href") ?? "";
    const text = s.trim();
    if (/^(https?:|mailto:)/i.test(href)) {
      if (!text || text === href) return href;
      // `(`, `)` và khoảng trắng trong URL làm gãy cú pháp [..](..) — encodeURIComponent
      // lại không mã hoá ngoặc, nên thay tay.
      const url = href.replace(/[()\s]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : "%20"));
      return `[${text.replace(/[[\]]/g, "\\$&")}](${url})`;
    }
    return s;
  }
  if (isBold(el)) s = wrapInline(s, "**");
  if (isItalic(el)) s = wrapInline(s, "*");
  if (isStrike(el)) s = wrapInline(s, "~~");
  return s;
}

/** Gom các dòng của một đoạn: bỏ khoảng trắng thừa đầu/cuối mỗi dòng. */
const tidy = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function blocks(parent: Node): Block[] {
  const out: Block[] = [];
  let buf = "";
  const flush = () => {
    const t = tidy(buf);
    if (t) for (const para of t.split(/\n{2,}/)) out.push({ md: para });
    buf = "";
  };
  for (const c of parent.childNodes) {
    if (isEl(c) && BLOCK_TAGS.has(c.tagName)) {
      flush();
      out.push(...blockOf(c));
    } else if (isEl(c) && c.querySelector(BLOCK_SELECTOR)) {
      // Thẻ inline bọc cả khối (Google Docs bọc mọi thứ trong một <b>) — coi
      // như container, không thì cả tài liệu bị dẹt thành một dòng.
      flush();
      out.push(...blocks(c));
    } else {
      buf += inline(c);
    }
  }
  flush();
  return out;
}

function blockOf(el: HTMLElement): Block[] {
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) {
    const text = tidy(inline(el)).replace(/\n+/g, " ");
    return text ? [{ md: `${"#".repeat(Number(tag[1]))} ${text}` }] : [];
  }
  if (tag === "UL" || tag === "OL" || tag === "LI") {
    const md = list(el, 0).join("\n");
    return md ? [{ md, list: true }] : [];
  }
  if (tag === "HR") return [{ md: "---" }];
  if (tag === "PRE") {
    const code = el.querySelector("code");
    const lang = /language-([\w+#-]+)/.exec(code?.className ?? "")?.[1] ?? "";
    const text = inlinePre(el).replace(/\n+$/, "");
    const fence = text.includes("```") ? "````" : "```";
    return [{ md: `${fence}${lang}\n${text}\n${fence}` }];
  }
  if (tag === "BLOCKQUOTE") {
    const inner = join(blocks(el));
    return inner ? [{ md: inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") }] : [];
  }
  if (tag === "TABLE") {
    const md = table(el);
    return md ? [{ md }] : [];
  }
  return blocks(el);
}

/** Text trong <pre> giữ nguyên xuống dòng; <br> và <div> mỗi dòng cũng là xuống dòng. */
function inlinePre(el: Node): string {
  let s = "";
  for (const c of el.childNodes) {
    if (c.nodeType === Node.TEXT_NODE) s += (c.textContent ?? "").replace(/\u00a0/g, " ");
    else if (isEl(c) && c.tagName === "BR") s += "\n";
    else if (isEl(c) && (c.tagName === "DIV" || c.tagName === "P")) s += `${inlinePre(c)}\n`;
    else s += inlinePre(c);
  }
  return s;
}

/** Cấp thụt lề Slack ghi trên thẻ (nó KHÔNG lồng <ul> mà xếp các <ul> phẳng). */
const slackIndent = (el: HTMLElement) => {
  const v = el.dataset.stringifyIndent ?? el.dataset.indent;
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : null;
};

function list(el: HTMLElement, depth: number): string[] {
  const lines: string[] = [];
  if (el.tagName === "LI") return item(el, depth, "-");
  const ordered = el.tagName === "OL";
  let n = Number(el.getAttribute("start") ?? 1) || 1;
  const own = slackIndent(el);
  for (const c of el.children) {
    const li = c as HTMLElement;
    if (li.tagName === "UL" || li.tagName === "OL") {
      lines.push(...list(li, depth + 1)); // <ul> lồng thẳng trong <ul> (HTML sai nhưng hay gặp)
    } else if (li.tagName === "LI") {
      const level = slackIndent(li) ?? own ?? depth;
      lines.push(...item(li, level, ordered ? `${n++}.` : "-"));
    }
  }
  return lines;
}

function item(li: HTMLElement, depth: number, marker: string): string[] {
  const pad = "\t".repeat(depth);
  const nested: HTMLElement[] = [];
  const body = document.createElement("div");
  for (const c of [...li.childNodes]) {
    if (isEl(c) && (c.tagName === "UL" || c.tagName === "OL")) nested.push(c);
    else body.append(c.cloneNode(true));
  }
  let text = join(blocks(body), "\n");
  // Checkbox của GitHub/Notion → task list.
  const box = li.querySelector<HTMLInputElement>(":scope > input[type=checkbox], :scope > p > input[type=checkbox]");
  if (box) text = `[${box.checked ? "x" : " "}] ${text}`;
  const [first = "", ...rest] = text.split("\n");
  const lines = [`${pad}${marker} ${first}`.trimEnd()];
  for (const r of rest) lines.push(`${pad}\t${r}`);
  for (const n of nested) lines.push(...list(n, depth + 1));
  return lines;
}

function table(el: HTMLElement): string {
  const rows = [...el.querySelectorAll("tr")].map((tr) =>
    [...tr.querySelectorAll("th,td")].map((c) =>
      tidy(inline(c)).replace(/\n+/g, " ").replace(/\|/g, "\\|"),
    ),
  );
  if (!rows.length) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols === 0) return "";
  const line = (r: string[]) =>
    `| ${Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head), `| ${Array(cols).fill("---").join(" | ")} |`, ...body.map(line)].join("\n");
}

const join = (bs: Block[], sep = "\n\n") => {
  let s = "";
  bs.forEach((b, i) => {
    if (i > 0) s += b.list && bs[i - 1].list ? "\n" : sep;
    s += b.md;
  });
  return s;
};

/** HTML trong clipboard → Markdown; null = không đáng chuyển, dán text thường. */
export function htmlToMarkdown(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.body.querySelector(MEANINGFUL)) return null;
  const md = join(blocks(doc.body)).replace(/\n{3,}/g, "\n\n").trim();
  return md || null;
}

// Bản text/plain của Slack (không có HTML, hay dán từ app khác của Slack):
//   •  cụm CR exit-code:
//       ◦  dev 100%
const BULLET_LINE = /^([ \t]*)[•◦▪▫‣⁃●○■□][ \t]+/;

/** Đổi dòng bắt đầu bằng ký tự bullet thành list Markdown; null = không có gì để đổi.
 *  Cấp thụt lề tính theo THỨ HẠNG độ thụt (0, 4, 8… hay 0, 2, 4… đều ra 0, 1, 2). */
export function bulletsToMarkdown(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const width = (ws: string) => ws.replace(/\t/g, "    ").length;
  const widths = new Set<number>();
  for (const l of lines) {
    const m = l.match(BULLET_LINE);
    if (m) widths.add(width(m[1]));
  }
  if (!widths.size) return null;
  const rank = [...widths].sort((a, b) => a - b);
  return lines
    .map((l) => {
      const m = l.match(BULLET_LINE);
      if (!m) return l;
      return `${"\t".repeat(rank.indexOf(width(m[1])))}- ${l.slice(m[0].length)}`;
    })
    .join("\n");
}
