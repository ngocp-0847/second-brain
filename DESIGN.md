---
version: alpha
name: Second Brain
description: Visual identity của app quản lý tri thức local-first — tối, tĩnh lặng, lấy nội dung làm trung tâm.
colors:
  primary: "#A48FFF"
  accent-strong: "#D4C9FF"
  accent-bg: "#A48FFF26"
  accent-border: "#A48FFF55"
  bg: "#16181F"
  bg-ribbon: "#14161D"
  bg-side: "#1B1E28"
  bg-panel: "#1E2130"
  border: "#2A2F42"
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

Second Brain là công cụ tư duy dùng hằng ngày, nhiều giờ liền. Thiết kế phải **tĩnh lặng và nhường chỗ cho nội dung**: nền tối trầm, chữ sáng dịu (không trắng tinh), một màu nhấn tím duy nhất. Không trang trí thừa, không gradient ồn ào, không animation gây chú ý. Cảm giác chuẩn: một thư viện đêm — ấm, tập trung, đáng tin.

## Colors

- Nền chia 4 tầng theo độ sâu: `bg-ribbon` (tối nhất, ngoài cùng) → `bg-side` (sidebar) → `bg` (vùng nội dung) → `bg-panel` (modal/card nổi trên cùng). Đi từ ngoài vào trong màn hình là đi từ tối đến sáng dần — người dùng luôn biết mình đang nhìn tầng nào.
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
- Icon dùng **SVG stroke 1.5–2px, currentColor**, cỡ 18–22px — không trộn emoji với SVG trong cùng một cụm điều khiển.

## Do's and Don'ts

**Do**
- Dùng token qua CSS custom property (`var(--accent)`) — không hardcode hex trong rule mới.
- Giữ mỗi màn hình đúng một hành động chính (một button-primary).
- Hover đổi nền, không đổi layout (không dịch chuyển phần tử).

**Don't**
- Không thêm màu nhấn thứ hai; không dùng tím cho lỗi/cảnh báo.
- Không dùng pure black / pure white.
- Không animation dài quá 150ms cho tương tác thường ngày.
