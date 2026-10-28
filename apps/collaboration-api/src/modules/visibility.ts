import type { EntityOccupancyView, EntityView } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';

// Shared draft cards contain directory and control fields; only accepted fixed material is shared.
export function visibleEntity(entity: EntityView, actor: Actor): EntityView | EntityOccupancyView {
  if (entity.authorId === actor.id || entity.current) return entity;
  const { id, kind, title, summary, sequence, code, creator, lastEditor, authorId, confirmationStatus, materialVersion, revision, taskStatus, occupation, builtinKey } = entity;
  return { id, kind, title, summary, sequence, code, creator, lastEditor, authorId, confirmationStatus, materialVersion, revision, taskStatus, occupation, builtinKey };
}
