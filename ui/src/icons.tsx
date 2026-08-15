// Một nguồn icon duy nhất cho toàn app: Lucide, đặt lại tên theo NGỮ NGHĨA trong
// app chứ không theo hình vẽ. Muốn đổi hình của một chức năng thì sửa đúng một
// dòng ở đây, không phải đi lùng khắp JSX.
//
// Kích thước đặt bằng CSS (`width/height` của rule thắng attribute mà Lucide
// sinh ra), stroke-width đặt một lần qua <LucideProvider> ở main.tsx. Nhờ vậy
// không chỗ nào cần truyền size/strokeWidth thủ công — đúng DESIGN.md:108
// "SVG stroke 1.5–2px, currentColor, cỡ 18–22px".
export {
  // ---- ribbon ----
  Search as IconSearch,
  MessageCircleQuestion as IconAsk,
  Network as IconGraph,
  CalendarDays as IconDaily,
  Shapes as IconCanvas,
  Brush as IconJanitor,
  ArrowUpDown as IconSync,
  Bot as IconAgent,
  Terminal as IconTerminal,
  Library as IconVault,
  Settings as IconSettings,
  Sun as IconLight,
  Moon as IconDark,
  Monitor as IconSystemTheme,
  // ---- sidebar ----
  FilePlus2 as IconNewNote,
  FolderPlus as IconNewFolder,
  RefreshCw as IconReindex,
  ChevronRight as IconDirArrow,
  // ---- tab bar ----
  X as IconClose,
  Plus as IconAdd,
  ArrowLeft as IconBack,
  ArrowRight as IconForward,
  PanelRight as IconPanelOpen,
  PanelRightClose as IconPanelClose,
  // ---- note header ----
  History as IconHistory,
  Pencil as IconRename,
  Trash2 as IconTrash,
  Undo2 as IconRestore,
  // ---- vùng chọn → AI ----
  Sparkles as IconAi,
  Send as IconSend,
  Table as IconTable,
  Scissors as IconShorten,
  List as IconBullets,
  SpellCheck as IconSpell,
  Languages as IconTranslate,
  // ---- chat ----
  RotateCcw as IconRestart,
  Link2 as IconLink,
  FolderTree as IconTree,
  Pin as IconPin,
  Paperclip as IconAttach,
  // ---- trạng thái ----
  Check as IconOk,
  CircleCheck as IconAllClear,
  // ---- context menu (chuột phải trong sidebar) ----
  SquareArrowOutUpRight as IconOpenNewTab,
  AppWindow as IconNewWindow,
  CopyPlus as IconDuplicate,
  FolderInput as IconMove,
  ClipboardCopy as IconCopyPath,
  ExternalLink as IconOpenExternal,
  FolderOpen as IconReveal,
  Bookmark as IconBookmark,
  BookmarkX as IconUnbookmark,
  // ---- thanh format của card text trên canvas ----
  Bold as IconBold,
  Italic as IconItalic,
  Heading as IconHeading,
  Code as IconCode,
  // ---- canvas toolbar ----
  MousePointer2 as IconCursor,
  Type as IconTextCard,
  ChevronUp as IconCaret,
  FileText as IconNoteCard,
  Image as IconImage,
  CircleHelp as IconHelp,
  Redo2 as IconRedo,
  Group as IconGroup,
  Ungroup as IconUngroup,
  // ---- menu chuột phải trên canvas ----
  Copy as IconCopy,
  ClipboardPaste as IconPaste,
  Lock as IconLock,
  LockOpen as IconUnlock,
  Layers as IconArrange,
  MoveUp as IconBringForward,
  BringToFront as IconBringFront,
  MoveDown as IconSendBackward,
  SendToBack as IconSendBack,
  SquareDashedMousePointer as IconSelectAll,
  Maximize as IconFit,
} from "lucide-solid";

// IconUndo trùng tên với IconRestore (cùng là Undo2) nên export riêng cho rõ ý.
export { Undo2 as IconUndo } from "lucide-solid";
