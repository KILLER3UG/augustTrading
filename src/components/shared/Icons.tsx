/**
 * The icon layer — the ONE place feature code imports icons from.
 *
 * Three things live here and the split is deliberate:
 *
 * 1. Legacy aliases below (`Bot as BotIcon`). ~64 names kept for the files
 *    that have imported them since the layer was introduced. Do not remove one
 *    to "tidy" this file — a rename is a breaking change with no payoff, and
 *    the alias and the plain name below are the same component either way.
 *
 * 2. The canonical surface below: every lucide name this app uses, re-exported
 *    VERBATIM so a caller writes the same identifier lucide documents. The
 *    rule this encodes is about WHERE an icon comes from, not what it is
 *    called — importing through here means the size set and stroke weight are
 *    one decision in one file, instead of 77 feature files each reaching past
 *    it into the library.
 *
 * 3. `LoadingIcon`, the one wrapped icon.
 *
 * `SearchIcon` and `ChevronDownIcon` are deliberately absent from (2): the
 * legacy aliases already publish exactly those names, and two exports of one
 * name is a compile error. Callers wanting that spelling get the identical
 * component from (1).
 *
 * Identity graphics are NOT icons and do not come from here: bot avatars
 * (`BotFace`, `pixelAvatars`), sparklines, donut charts and the
 * brand wordmark are data or identity, governed by their own palettes.
 */
import React from 'react';
import { Loader2, type LucideProps } from 'lucide-react';

// ---------------------------------------------------------------------------
// Direct re-exports: lucide icon → legacy name
// ---------------------------------------------------------------------------
export {
  User as UserIcon,
  Bot as BotIcon,
  Upload as UploadIcon,
  Send as SendIcon,
  X as CloseIcon,
  Link as LinkIcon,
  History as HistoryIcon,
  Search as SearchIcon,
  FileCode2 as CodeIcon,
  Copy as CopyIcon,
  Check as CheckIcon,
  CheckCircle2 as WinIcon,
  XCircle as LossIcon,
  Ban as SkipIcon,
  Share2 as ShareIcon,
  Trash2 as TrashIcon,
  Archive as ArchiveIcon,
  Users as SwitchUserIcon,
  Download as ExportIcon,
  Bookmark as BookmarkIcon,
  ArrowDown as ArrowDownIcon,
  ArrowUp as ArrowUpIcon,
  ChevronDown as ChevronDownIcon,
  Lock as LockIcon,
  Settings as SettingsIcon,
  Eye as EyeIcon,
  Pin as PinIcon,
  Star as StarIcon,
  MoreVertical as KebabMenuIcon,
  Maximize as FullscreenEnterIcon,
  Minimize as FullscreenExitIcon,
  Brain as BrainIcon,
  Pencil as EditIcon,
  RefreshCw as RefreshIcon,
  RefreshCw as UpdateIcon,
  RefreshCw as RetryIcon,
  BarChart3 as ChartBarIcon,
  Activity as ActivityIcon,
  Timer as TimerIcon,
  Bell as BellIcon,
  Camera as CameraIcon,
  Plus as PlusIcon,
  FlaskConical as AISettingsIcon,
  ChevronUp as ChevronUpIcon,
  ChevronRight as ChevronRightIcon,
  ChevronLeft as ChevronLeftIcon,
  CloudOff as CloudOffIcon,
  Wifi as WifiIcon,
  Menu as HamburgerIcon,
  TrendingUp as TrendUpIcon,
  TrendingDown as TrendDownIcon,
  AlertTriangle as AlertTriangleIcon,
  Square as StopIcon,
  Layers as LayersIcon,
  Target as TargetIcon,
  Zap as ZapIcon,
  Server as ServerIcon,
  AreaChart as AreaChartIcon,
  BrainCircuit as BrainCircuitIcon,
  Cpu as CpuIcon,
  MessageSquare as MessageSquareIcon,
  Circle as CircleIcon,
  Folder as FolderIcon,
  FileText as FileTextIcon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// The canonical surface: every lucide name this app uses, under the name
// lucide itself documents. Import icons from this module, never from
// 'lucide-react' — that is the whole point of the layer.
// ---------------------------------------------------------------------------
export {
  Activity,
  AlertCircle,
  AlertTriangle,
  AreaChart,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  Ban,
  BarChart2,
  BarChart3,
  Bookmark,
  Box,
  BookOpen,
  Bot,
  Brain,
  BrainCircuit,
  Camera,
  Check,
  CheckCircle,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Code,
  Compass,
  Copy,
  Cpu,
  Crosshair,
  Database,
  Download,
  Ellipsis,
  Eraser,
  Eye,
  EyeOff,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  Flag,
  FlaskConical,
  Gauge,
  Gavel,
  GraduationCap,
  Grid3x3,
  GripVertical,
  HardDrive,
  History,
  Inbox,
  Info,
  Layers,
  LayoutGrid,
  Lightbulb,
  ListChecks,
  Loader2,
  Lock,
  LogOut,
  UsersRound,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  Minus,
  MoreHorizontal,
  MousePointer2,
  NotebookPen,
  Palette,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightOpen,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  PowerOff,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Scale,
  Search,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Square,
  Target,
  ThumbsDown,
  ThumbsUp,
  Timer,
  Trash2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Type,
  Undo2,
  Upload,
  User,
  Users,
  Volume2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
export type { LucideProps } from 'lucide-react';

// ---------------------------------------------------------------------------
// Wrapped icons that need special behaviour
// ---------------------------------------------------------------------------

/** Spinning loader — wraps lucide Loader2 with animate-spin. */
export const LoadingIcon: React.FC<LucideProps> = (props) => (
  <Loader2 {...props} className={`animate-spin ${props.className ?? ''}`} />
);

