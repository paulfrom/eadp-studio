import type { EntityOccupancyView, EntityView } from '@eadp/contracts';
import type { Actor } from '../auth/session.js';

// Unconfirmed entities expose their occupancy card only; the author and every confirmed entity stay fully visible.
export function visibleEntity(entity: EntityView, actor: Actor): EntityView | EntityOccupancyView {
  if (entity.authorId === actor.id || entity.confirmationStatus === 'confirmed') return entity;
  const { id, kind, revision, taskStatus, occupation } = entity;
  return { id, kind, revision, taskStatus, ...(occupation ? { occupation } : {}) };
}
