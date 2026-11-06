import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { EadpPrototypeClient } from './prototype.js'
import type { EadpShellClient, EadpRequirementsClient, EadpRequirementsSlotProps, EadpPrototypeSlotProps, EadpKnowledgeSlotProps } from './local-workbench.js'
declare module '@deepseek-ai/cordis' {
  interface Context { eadpRequirementsClient: EadpRequirementsClient; eadpShellClient: EadpShellClient; eadpPrototypeClient: EadpPrototypeClient }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'eadp.requirements.view': { kind: 'single'; scope: 'root'; owner: EadpRequirementsSlotProps }
    'eadp.prototype.view': { kind: 'single'; scope: 'root'; owner: EadpPrototypeSlotProps }
    'eadp.knowledge.view': { kind: 'single'; scope: 'root'; owner: EadpKnowledgeSlotProps }
  }
}
export type { EadpRequirementsClient }
