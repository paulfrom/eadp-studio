import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { requireCondition } from '@eadp/asset-domain';
import type { Config } from '../config.js';
interface PublicationClaims { purpose: 'publication-current'; projectId: string; baselineId: string; acceptedHead: string; actorId: number; issuedAt: number; expiresAt: number; nonce: string }
export class PublicationAuthorization {
  constructor(private readonly config: Config) {}
  assertPublisher(actorId: number) { requireCondition(this.config.publisherIds.has(actorId), 'PUBLISHER_REQUIRED', 'Independent publication authorization is required', 403); }
  private key(): string {
    const key = this.config.publicationTokenSecret;
    requireCondition(key && Buffer.byteLength(key, 'utf8') >= 32, 'PUBLICATION_NOT_CONFIGURED', 'Configure a publication token secret of at least 32 bytes', 503); return key;
  }
  issue(projectId: string, baselineId: string, acceptedHead: string, actorId: number) {
    this.assertPublisher(actorId);
    requireCondition(this.config.publicApiUrl, 'PUBLICATION_NOT_CONFIGURED', 'Configure the public collaboration API URL before remote publication', 503);
    const issuedAt = Math.floor(Date.now() / 1000), claims: PublicationClaims = { purpose: 'publication-current', projectId, baselineId, acceptedHead, actorId, issuedAt, expiresAt: issuedAt + 300, nonce: randomUUID() };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'), signature = createHmac('sha256', this.key()).update(payload).digest('base64url');
    return { url: `${this.config.publicApiUrl}/v1/projects/${encodeURIComponent(projectId)}/publication-current`, token: `${payload}.${signature}`, expiresAt: new Date(claims.expiresAt * 1000).toISOString() };
  }
  verify(authorization: string | undefined, projectId: string): PublicationClaims {
    requireCondition(typeof authorization === 'string' && authorization.startsWith('Bearer ') && authorization.length <= 4096, 'PUBLICATION_TOKEN_REQUIRED', 'A scoped publication token is required', 401);
    const parts = authorization.slice(7).split('.');
    requireCondition(parts.length === 2 && parts.every(x => /^[A-Za-z0-9_-]+$/.test(x)), 'INVALID_PUBLICATION_TOKEN', 'Publication token is invalid', 401);
    const expected = createHmac('sha256', this.key()).update(parts[0]!).digest(), supplied = Buffer.from(parts[1]!, 'base64url');
    requireCondition(expected.length === supplied.length && timingSafeEqual(expected, supplied), 'INVALID_PUBLICATION_TOKEN', 'Publication token is invalid', 401);
    let claims: PublicationClaims;
    try { claims = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as PublicationClaims; }
    catch { requireCondition(false, 'INVALID_PUBLICATION_TOKEN', 'Publication token is invalid', 401); }
    const current = Math.floor(Date.now() / 1000);
    requireCondition(claims!.purpose === 'publication-current' && claims!.projectId === projectId && Number.isInteger(claims!.issuedAt) && Number.isInteger(claims!.expiresAt) && claims!.expiresAt > current && claims!.issuedAt <= current + 30 && claims!.expiresAt - claims!.issuedAt <= 300, 'EXPIRED_PUBLICATION_TOKEN', 'Publication token is expired or outside its project scope', 401);
    this.assertPublisher(claims!.actorId); return claims!;
  }
}
