// Ảnh dùng chung cho canvas và live preview của editor.
//
// WebView không đọc được file ngoài thư mục app, nên ảnh trong vault phải đi qua
// backend rồi nhúng làm data-url. Ảnh remote (http/https/data) thì để nguyên URL —
// CSP đang tắt nên WebView tải thẳng được.

import { api } from "./api";

export const IMG_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
const IMG_RE = new RegExp(`\\.(${IMG_EXTS.join("|")})$`, "i");
export const isImagePath = (p?: string) => !!p && IMG_RE.test(p);

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
};

/** URL tải thẳng được, không cần qua backend. */
export const isRemoteSrc = (src: string) => /^(https?:|data:)/i.test(src);

// Cache data-url theo path để không đọc lại file mỗi lần re-render.
const imgCache = new Map<string, Promise<string>>();

export const loadImage = (path: string) => {
  let p = imgCache.get(path);
  if (!p) {
    const ext = path.split(".").pop()!.toLowerCase();
    p = api.readAsset(path).then((b64) => `data:${MIME[ext] ?? "image/png"};base64,${b64}`);
    imgCache.set(path, p);
  }
  return p;
};

/**
 * `src` trong markdown → thứ gán được vào `<img>`. Remote trả về ngay, local đọc
 * qua vault. Path local được decode %20 và bỏ `./` đầu cho khớp path thật.
 */
export const resolveImageSrc = (src: string): Promise<string> => {
  if (isRemoteSrc(src)) return Promise.resolve(src);
  let rel = src.replace(/^\.\//, "").replace(/^\//, "");
  try {
    rel = decodeURIComponent(rel);
  } catch {
    // src có % không phải escape hợp lệ — dùng nguyên bản.
  }
  return loadImage(rel);
};
