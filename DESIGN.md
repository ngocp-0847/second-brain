---
version: alpha
name: Second Brain
description: Visual identity của app quản lý tri thức local-first — tĩnh lặng, lấy nội dung làm trung tâm. Hai theme sáng/tối cùng một bộ token.
# Bộ token dark (mặc định). Khớp 1-1 với :root trong ui/src/styles.css.
colors:
  primary: "#A48FFF"
  accent-strong: "#D4C9FF"
  accent-bg: "#A48FFF26"
  accent-bg-hover: "#A48FFF3D"
  accent-border: "#A48FFF55"
  bg: "#16181F"
  bg-ribbon: "#14161D"
  bg-side: "#1B1E28"
  bg-panel: "#1E2130"
  border: "#2A2F42"
  border-card: "#3A415A"
  fg: "#C7CDDD"
  fg-strong: "#E8EAF2"
  fg-soft: "#A9B1C5"
  fg-muted: "#8B93A7"
  fg-faint: "#67708A"
  link: "#8FA8FF"
  success: "#9ECE8F"
  warning: "#E8C76A"
  danger: "#E0876A"
  code: "#E0B06A"
  hover: "#FFFFFF14"
  hover-soft: "#FFFFFF0D"
  overlay: "#00000066"
  selection: "#3B4261"
  line-active: "#FFFFFF08"
  scrollbar: "#2F3549"
  canvas-dot: "#FFFFFF0D"
  group-bg: "#FFFFFF06"
  edge: "#4A5170"
  on-sticky: "#1B1E28"
# Cùng tên token, khác giá trị. Khớp 1-1 với :root[data-theme="light"].
colorsLight:
  primary: "#7A5CF0"
  accent-strong: "#5A35D6"
  accent-bg: "#7A5CF01F"
  accent-bg-hover: "#7A5CF033"
  accent-border: "#7A5CF066"
  bg: "#F7F8FB"
  bg-ribbon: "#E6E7EE"
  bg-side: "#EEF0F5"
  bg-panel: "#FDFDFF"
  border: "#D9DCE6"
  border-card: "#C3C8D6"
  fg: "#383D4E"
  fg-strong: "#1B1E28"
  fg-soft: "#4E5568"
  fg-muted: "#6B7285"
  fg-faint: "#8B93A7"
  link: "#3B5BDB"
  success: "#3F8F4F"
  warning: "#9A7212"
  danger: "#C0492A"
  code: "#A8600A"
  hover: "#0000000F"
  hover-soft: "#00000008"
  overlay: "#1B1E2859"
  selection: "#CDD7F5"
  line-active: "#00000006"
  scrollbar: "#C3C8D6"
  canvas-dot: "#00000014"
  group-bg: "#00000008"
  edge: "#9AA3B8"
  on-sticky: "#1B1E28"
typography:
  body:
    fontFamily: Segoe UI, system-ui, sans-serif
    fontSize: 14px
    lineHeight: 1.5
  editor:
    fontFamily: Segoe UI, system-ui, sans-serif
    fontSize: 15.5px
    lineHeight: 1.65
  mono:
    fontFamily: Cascadia Code, Consolas, monospace
    fontSize: 13px
  panel-title:
    fontFamily: Segoe UI, system-ui, sans-serif
    fontSize: 11px
    fontWeight: 600
    letterSpacing: 0.08em
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
rounded:
  sm: 6px
  md: 8px
  lg: 10px
  full: 9999px
components:
  button-primary:
    backgroundColor: "{colors.accent-bg}"
    textColor: "{colors.accent-strong}"
    borderColor: "{colors.accent-border}"
    rounded: "{rounded.sm}"
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
  modal:
    backgroundColor: "{colors.bg-panel}"
    borderColor: "{colors.border}"
    rounded: "{rounded.lg}"
  card:
    backgroundColor: "{colors.bg-panel}"
    borderColor: "#3A415A"
    rounded: "{rounded.lg}"
---

## Overview

Second Brain là công cụ tư duy dùng hằng ngày, nhiều giờ liền. Thiết kế phải **tĩnh lặng và nhường chỗ cho nội dung**: nền trầm, chữ tương phản vừa đủ (không trắng tinh, không đen tuyệt đối), một màu nhấn tím duy nhất. Không trang trí thừa, không gradient ồn ào, không animation gây chú ý. Cảm giác chuẩn ở dark: một thư viện đêm — ấm, tập trung, đáng tin; ở light: một trang giấy sạch dưới ánh sáng ban ngày — cùng sự tĩnh lặng đó.

## Theme

Hai theme dùng **cùng một bộ tên token**, chỉ khác giá trị — không có token nào chỉ tồn tại ở một theme. Người dùng chọn `system` / `light` / `dark`; `system` được quy đổi qua `matchMedia` rồi đóng dấu `data-theme` tường minh lên `<html>` **trước khi paint**, nên CSS chỉ cần biết hai trạng thái.

Quy tắc khi đặt giá trị cho theme mới:
- Giữ **nghĩa** của token, không giữ độ sáng. `accent-strong` luôn là nấc tương phản cao hơn `accent` — ở dark nó sáng hơn, ở light nó sẫm hơn.
- `hover`/`hover-soft` là lớp phủ trắng ở dark và lớp phủ đen ở light.
- Màu nhấn phải đủ tương phản trên nền của chính theme đó (tím dark `#a48fff` chỉ đạt ~2.3:1 trên nền sáng — light phải dùng bản sẫm hơn).
- **Không mượn token nền làm màu chữ.** Nền cố định (giấy nhớ pastel) cần token mực riêng (`on-sticky`) giữ nguyên ở cả hai theme.
- Renderer không hiểu `var()` (canvas 2D của graph, xterm, mermaid) phải đọc token lúc chạy hoặc được báo đổi theme tường minh.

## Colors

- Nền chia 4 tầng theo độ sâu: `bg-ribbon` (chìm nhất, ngoài cùng) → `bg-side` (sidebar) → `bg` (vùng nội dung) → `bg-panel` (modal/card nổi trên cùng). Đi từ ngoài vào trong là đi từ chìm đến nổi — người dùng luôn biết mình đang nhìn tầng nào. Ở dark "chìm" nghĩa là tối hơn, ở light nghĩa là xám hơn.
- Chữ có 5 nấc rõ ràng: `fg-strong` (heading) → `fg` (thân bài) → `fg-soft` → `fg-muted` (phụ chú) → `fg-faint` (hint, placeholder). **Không tự chế giá trị xám mới** — chỉ dùng 5 nấc này.
- `primary` (tím) là màu nhấn **duy nhất**, dành cho: wikilink, phần tử đang active, nút hành động chính. Link ngoài dùng `link` (xanh). Trạng thái dùng đúng bộ `success`/`warning`/`danger`.

## Typography

- Một font UI duy nhất (Segoe UI/system-ui); code dùng Cascadia/Consolas. Không thêm font.
- Editor lớn hơn UI (15.5px vs 14px) vì là nơi đọc/viết chính.
- Tiêu đề panel (backlinks, canvas…) dùng kiểu `panel-title`: uppercase, 11px, letter-spacing rộng, màu `fg-faint`.

## Layout

- Bố cục cột cố định: ribbon 46px → sidebar 230px → nội dung co giãn → panel phải 230px; status bar 26px suốt chiều ngang.
- Khoảng cách theo thang `spacing`, mặc định `sm` (8px) trong nhóm, `md` (12px) giữa các nhóm. Không dùng số lẻ ngoài thang.
- Nội dung editor giới hạn 46rem, căn giữa — dòng dài quá khó đọc.

## Elevation & Depth

Độ sâu thể hiện bằng **màu nền + border**, hạn chế shadow. Chỉ phần tử nổi thật sự (modal, card canvas, toolbar nổi) được dùng shadow (`0 18px 50px #00000080` cho modal, nhẹ hơn cho card). Không dùng shadow cho phần tử nằm trong luồng.

## Shapes

Bo góc theo thang `rounded`: 6px cho phần tử nhỏ (nút, item), 8px cho khối trung bình, 10px cho modal/card. Không bo tròn hoàn toàn trừ khi là badge/pill.

## Components

- **button-primary**: nền `accent-bg`, viền `accent-border`, chữ `accent-strong` — dùng cho hành động chính duy nhất trong một ngữ cảnh (Áp dụng, Lưu thành note).
- **button-ghost**: trong suốt, hover mới hiện nền `#ffffff14` — dùng cho icon và hành động phụ.
- **modal**: nền `bg-panel`, viền `border`, bo `lg`, overlay `#00000066`.
- Icon dùng **SVG stroke 1.5–2px, currentColor**, cỡ 18–22px — **không dùng emoji làm icon ở bất kỳ đâu**. Emoji màu không ăn `currentColor` nên không đổi theo theme và không đồng bộ với SVG. Nguồn icon duy nhất: Lucide, khai báo lại theo tên ngữ nghĩa trong `ui/src/icons.tsx`; stroke-width đặt một lần qua `LucideProvider`, cỡ đặt bằng CSS.

## Do's and Don'ts

**Do**
- Dùng token qua CSS custom property (`var(--accent)`) — không hardcode hex trong rule mới.
- Giữ mỗi màn hình đúng một hành động chính (một button-primary).
- Hover đổi nền, không đổi layout (không dịch chuyển phần tử).

**Don't**
- Không thêm màu nhấn thứ hai; không dùng tím cho lỗi/cảnh báo.
- Không dùng pure black / pure white (light theme dùng off-white, không phải `#ffffff`).
- Không hardcode hex ngoài hai khối token trong `styles.css`.
- Không animation dài quá 150ms cho tương tác thường ngày.
