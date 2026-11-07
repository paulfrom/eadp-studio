/**
 * The EADP UI primitive surface. Consumers import only from
 * `@eadp/shell/client/ui`; primitives never own product copy or theme state.
 */
export { Surface } from './ui/surface.tsx'
export { Button, IconButton } from './ui/button.tsx'
export type { ButtonProps, IconButtonProps } from './ui/button.tsx'
export { Input, Field } from './ui/input.tsx'
export { Notice } from './ui/notice.tsx'
export type { NoticeProps } from './ui/notice.tsx'
export { Badge } from './ui/badge.tsx'
export { Spinner } from './ui/spinner.tsx'
export { EmptyState } from './ui/empty-state.tsx'
export { Kbd } from './ui/kbd.tsx'
export { Dialog } from './ui/dialog.tsx'
export type { DialogProps } from './ui/dialog.tsx'
export { Menu } from './ui/menu.tsx'
export type { MenuItem } from './ui/menu.tsx'
export {
  IconFile, IconFolder, IconFolderOpen, IconPlus, IconMore, IconSearch, IconClose, IconCheck,
  IconSave, IconChevronRight, IconChevronDown, IconAlert, IconInfo, IconTrash, IconPencil,
  IconRefresh, IconSparkles, IconChat, IconPanelRight,
} from './ui/icons.tsx'
