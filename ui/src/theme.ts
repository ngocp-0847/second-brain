// Theme sáng/tối. Lựa chọn của người dùng có 3 trạng thái, nhưng DOM chỉ bao giờ
// mang đúng một trong hai giá trị data-theme="dark" | "light" — "system" được quy
// đổi qua matchMedia ngay tại đây. CSS nhờ vậy không cần @media prefers-color-scheme.
//
// Pref nằm ở localStorage chứ không phải tauri-plugin-store: script inline trong
// index.html phải đọc được nó ĐỒNG BỘ trước khi paint, nếu không app sẽ nháy trắng.
import { createSignal } from "solid-js";

export type ThemePref = "system" | "light" | "dark";
export type Resolved = "light" | "dark";

const KEY = "theme";
const media = window.matchMedia("(prefers-color-scheme: light)");

const readPref = (): ThemePref => {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
};

const resolve = (pref: ThemePref): Resolved =>
  pref === "system" ? (media.matches ? "light" : "dark") : pref;

const [themePref, setThemePrefSignal] = createSignal<ThemePref>(readPref());
const [theme, setTheme] = createSignal<Resolved>(resolve(readPref()));
export { themePref, theme };

/** True khi đang ở dark — tiện cho các API nhận boolean (CodeMirror, mermaid). */
export const isDark = () => theme() === "dark";

const apply = (pref: ThemePref) => {
  const next = resolve(pref);
  document.documentElement.dataset.theme = next;
  setTheme(next);
};

export function setThemePref(pref: ThemePref) {
  localStorage.setItem(KEY, pref);
  setThemePrefSignal(pref);
  apply(pref);
}

/** Toggle nhanh trên ribbon: luôn cho ra một lựa chọn tường minh, bỏ "system". */
export function toggleTheme() {
  setThemePref(theme() === "dark" ? "light" : "dark");
}

// Đang để "system" thì phải bám theo OS khi người dùng đổi trong lúc app đang chạy.
media.addEventListener("change", () => {
  if (themePref() === "system") apply("system");
});

/** Đọc giá trị thật của một CSS token — cho các renderer không hiểu var()
 *  (canvas 2D của graph view, xterm). Gọi trong vòng vẽ để tự bám theme. */
export const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
