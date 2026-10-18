/** Shared theme face: the Host's `ctx.theme` projected through the slot inject. */
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

export interface ThemeFace {
  getSnapshot(): ThemeSnapshot
  setPreference(id: 'system' | 'light' | 'dark'): void
  subscribe(listener: () => void): () => void
}
