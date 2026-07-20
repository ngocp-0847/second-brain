---
name: build-install
description: Build bản release Tauri (NSIS) và cài đặt silent vào máy Windows này. Dùng khi user muốn build release, tạo installer, hoặc cài app Second Brain vào máy.
---

# Build release & cài đặt Second Brain (Windows)

Quy trình đã kiểm chứng trên máy này (2026-07-19). Chạy từ thư mục gốc repo (`C:\Users\phan.ngoc\Documents\projects\second-brain`).

## Bước 1: Đóng app nếu đang chạy

Nếu app đang chạy thì cargo không xoá được exe cũ (`Access is denied. (os error 5)`):

```powershell
Get-Process -Name "second-brain" -ErrorAction SilentlyContinue | Stop-Process -Confirm:$false
```

## Bước 2: Build

**Lưu ý PATH:** `npm` và `cargo` KHÔNG có sẵn trong PATH của shell tool trên máy này. Dùng Bash tool với PATH tường minh, chạy nền (`run_in_background`) vì mất ~5 phút:

```bash
export PATH="/c/Program Files/nodejs:$USERPROFILE/.cargo/bin:$PATH"
npm run tauri build
```

`beforeBuildCommand` tự chạy `vite build` trước. Nếu thiếu dependency: `npm install` rồi build lại.

## Bước 3: Cài đặt silent

Installer nằm ở **workspace root target** (KHÔNG phải `src-tauri\target` — đây là Cargo workspace):

```
target\release\bundle\nsis\Second Brain_<version>_x64-setup.exe
```

`<version>` lấy từ `src-tauri/tauri.conf.json`. Cài silent với `/S` (per-user, không cần admin):

```powershell
$setup = Get-ChildItem "target\release\bundle\nsis\*-setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Start-Process -FilePath $setup.FullName -ArgumentList "/S" -Wait
```

## Bước 4: Xác nhận

```powershell
Test-Path "$env:LOCALAPPDATA\Second Brain\second-brain.exe"
```

- Exe: `%LOCALAPPDATA%\Second Brain\second-brain.exe`
- Shortcut: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Second Brain.lnk`

Báo cho user đường dẫn exe + shortcut. Không tự khởi động app trừ khi user yêu cầu.
