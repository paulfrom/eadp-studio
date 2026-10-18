import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { requireCondition } from '@eadp/asset-domain';
import type { LoginRequest, LoginResponse, StudioIdentity, StudioUser } from '@eadp/contracts';
import type { Config } from '../config.js';
import type { Database } from '../persistence/database.js';
import type { GitLab, GitLabUser } from './gitlab.js';

const testAccount = { id: 1, username: 'studioAdmin', name: '测试管理员', email: 'songlin.liu@changhong.com', password: 'admin@123', gitlabLookup: 'songlin.liu@changhong.com' };
interface UserRow { id: string | number; username: string; name: string; email: string; admin: boolean; password_salt: string; password_hash: string; gitlab_user_id: string | number | null; gitlab_username: string | null; gitlab_email: string | null }
export interface Actor extends StudioUser { sessionHash: string }
function publicUser(row: UserRow): StudioUser {
  const id = Number(row.id), gitlabUserId = Number(row.gitlab_user_id);
  requireCondition(Number.isSafeInteger(id) && id > 0 && row.gitlab_user_id !== null && Number.isSafeInteger(gitlabUserId) && gitlabUserId > 0 && row.gitlab_username, 'GITLAB_BINDING_REQUIRED', 'The Studio account has no verified GitLab user binding', 503);
  return { id, username: row.username, name: row.name, email: row.email, admin: row.admin, gitlabUserId, gitlabUsername: row.gitlab_username, ...(row.gitlab_email ? { gitlabEmail: row.gitlab_email } : {}) };
}
async function passwordHash(password: string, salt: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => { scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => { if (error) reject(error); else resolve(key); }); });
}
export class SessionAuth {
  constructor(private readonly database: Database, private readonly gitlab: GitLab, private readonly config: Config) {}
  async ensureTestUser(): Promise<void> {
    const salt = randomBytes(16).toString('hex'), hash = (await passwordHash(testAccount.password, salt)).toString('hex');
    await this.database.query('INSERT INTO studio_users(id,username,name,email,admin,password_salt,password_hash) VALUES($1,$2,$3,$4,true,$5,$6) ON CONFLICT(id) DO NOTHING', [testAccount.id, testAccount.username, testAccount.name, testAccount.email, salt, hash]);
  }
  private async account(): Promise<UserRow> {
    const row = (await this.database.query<UserRow>('SELECT * FROM studio_users WHERE id=$1', [testAccount.id])).rows[0];
    requireCondition(row, 'ACCOUNT_NOT_INITIALIZED', 'The Studio test account has not been initialized', 503); return row;
  }
  async login(input: LoginRequest): Promise<LoginResponse> {
    let row = await this.account();
    requireCondition(/^[a-f0-9]{32}$/.test(row.password_salt) && /^[a-f0-9]{128}$/.test(row.password_hash), 'ACCOUNT_INVALID', 'The Studio account password record is invalid', 503);
    const supplied = await passwordHash(input.password, row.password_salt);
    requireCondition(timingSafeEqual(supplied, Buffer.from(row.password_hash, 'hex')) && input.username === row.username, 'UNAUTHENTICATED', 'Studio username or password is invalid', 401);
    let remote: GitLabUser;
    if (row.gitlab_user_id === null) {
      remote = await this.gitlab.resolveUser(testAccount.gitlabLookup);
      // A concurrent login may have bound the account first. Never replace a
      // numeric binding because an email or username was subsequently reused.
      const updated = await this.database.query<UserRow>('UPDATE studio_users SET gitlab_user_id=$2,gitlab_username=$3,gitlab_email=$4 WHERE id=$1 AND gitlab_user_id IS NULL RETURNING *', [row.id, remote.id, remote.username, remote.email ?? null]);
      row = updated.rows[0] ?? await this.account();
    }
    remote = await this.gitlab.user(Number(row.gitlab_user_id));
    await this.database.query('UPDATE studio_users SET gitlab_username=$2,gitlab_email=$3 WHERE id=$1 AND gitlab_user_id=$4', [row.id, remote.username, remote.email ?? null, remote.id]);
    row.gitlab_username = remote.username; row.gitlab_email = remote.email ?? null;
    const token = `studio_${randomBytes(32).toString('base64url')}`, expiresAt = new Date(Date.now() + this.config.sessionTtlDays * 24 * 60 * 60 * 1000).toISOString();
    await this.database.query('INSERT INTO studio_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [this.hash(token), row.id, expiresAt]);
    return { token, expiresAt, user: publicUser(row), gitlabOrigin: this.config.gitlabUrl };
  }
  private hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
  async authenticate(authorization: string | undefined): Promise<Actor> {
    requireCondition(typeof authorization === 'string' && /^Bearer studio_[A-Za-z0-9_-]{43}$/.test(authorization), 'UNAUTHENTICATED', 'A current Studio session is required', 401);
    const sessionHash = this.hash(authorization.slice(7));
    const row = (await this.database.query<UserRow>('SELECT u.* FROM studio_sessions s JOIN studio_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp()', [sessionHash])).rows[0];
    requireCondition(row, 'UNAUTHENTICATED', 'Studio session is expired or revoked', 401);
    return { ...publicUser(row), sessionHash };
  }
  async boundUser(id: number): Promise<StudioUser> {
    const row = (await this.database.query<UserRow>('SELECT * FROM studio_users WHERE id=$1', [id])).rows[0];
    requireCondition(row, 'UNAUTHENTICATED', 'The Studio account is unavailable', 401); return publicUser(row);
  }
  identity(actor: Actor): StudioIdentity {
    const { id, username, name, email, admin, gitlabUserId, gitlabUsername, gitlabEmail } = actor;
    return { user: { id, username, name, email, admin, gitlabUserId, gitlabUsername, ...(gitlabEmail ? { gitlabEmail } : {}) }, gitlabOrigin: this.config.gitlabUrl };
  }
  async logout(actor: Actor): Promise<{ loggedOut: true }> {
    await this.database.query('DELETE FROM studio_sessions WHERE token_hash=$1 AND user_id=$2', [actor.sessionHash, actor.id]); return { loggedOut: true };
  }
}
