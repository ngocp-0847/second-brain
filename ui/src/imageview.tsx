// Xem ảnh trong vault. File trên đĩa không load thẳng vào WebView được (không có
// quyền file://) nên phải đi qua backend để lấy data-url. Chỉ để XEM — muốn sửa
// thì "Mở bằng app mặc định".
import { createEffect, createSignal, Show } from "solid-js";
import { resolveImageSrc } from "./assets";

export function ImageView(props: { path: string }) {
  const [src, setSrc] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  createEffect(() => {
    const p = props.path;
    setSrc(null);
    setErr(null);
    resolveImageSrc(p)
      .then(setSrc)
      .catch((e) => setErr(`Không đọc được ảnh: ${e}`));
  });
  return (
    <div class="image-view">
      <Show when={src()} fallback={<div class="image-view-msg">{err() ?? "Đang mở ảnh…"}</div>}>
        <img src={src()!} alt={props.path} />
      </Show>
    </div>
  );
}
