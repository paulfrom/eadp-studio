import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { EadpRequirementsClient, EadpRequirementsSlotProps, EadpPrototypeSlotProps, EadpKnowledgeSlotProps } from './local-workbench.js'
declare module '@deepseek-ai/cordis' {
  interface Context { eadpRequirementsClient: EadpRequirementsClient }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'eadp.requirements.view': { kind: 'single'; scope: 'root'; owner: EadpRequirementsSlotProps }
    'eadp.prototype.view': { kind: 'single'; scope: 'root'; owner: EadpPrototypeSlotProps }
    'eadp.knowledge.view': { kind: 'single'; scope: 'root'; owner: EadpKnowledgeSlotProps }
  }
}
export type { EadpRequirementsClient }
