import { LucideProvider } from "lucide-solid";
import { render } from "solid-js/web";
import App from "./App";
import "./styles.css";

// strokeWidth đặt một lần cho MỌI icon (Lucide mặc định 2, DESIGN.md muốn 1.5–2).
// Kích thước thì để CSS lo, vì mỗi cụm điều khiển có cỡ riêng.
render(
  () => (
    <LucideProvider strokeWidth={1.8}>
      <App />
    </LucideProvider>
  ),
  document.getElementById("root")!,
);
