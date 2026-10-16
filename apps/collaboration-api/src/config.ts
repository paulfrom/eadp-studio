import { requireCondition } from '@eadp/asset-domain';
import { parseVersion } from './desktop-update.js';
export interface Config { databaseUrl: string; databaseSsl: boolean; gitlabUrl: string; gitlabToken?: string; host: string; port: number; publisherIds: Set<number>; publicationTokenSecret?: string; publicApiUrl?: string; desktopUpdate?: { minVersion: string; title?: string; detail?: string; appLink?: string } }
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  requireCondition(env.DATABASE_URL && env.GITLAB_URL, 'CONFIG_REQUIRED', 'DATABASE_URL and GITLAB_URL are required', 500);
  requireCondition(env.PG_SSL === 'require' || env.PG_SSL === 'disable', 'CONFIG_REQUIRED', 'Set PG_SSL explicitly to require or disable', 500);
  let url: URL;
  try { url = new URL(env.GITLAB_URL); } catch { requireCondition(false, 'INVALID_CONFIG', 'Invalid GitLab URL', 500); }
  requireCondition(url!.protocol === 'https:' || (url!.protocol === 'http:' && env.GITLAB_ALLOW_HTTP === 'true'), 'INVALID_CONFIG', 'GitLab must use HTTPS unless explicitly allowed for the test network', 500);
  requireCondition(!url!.username && !url!.password && !url!.search && !url!.hash && url!.pathname === '/', 'INVALID_CONFIG', 'GitLab URL must be an origin without credentials, query or fragment', 500);
  const port = Number(env.PORT ?? 3001);
  requireCondition(Number.isInteger(port) && port > 0 && port < 65536, 'INVALID_CONFIG', 'Invalid API port', 500);
  if (env.PUBLIC_API_URL) {
    let publicUrl: URL;
    try { publicUrl = new URL(env.PUBLIC_API_URL); } catch { requireCondition(false, 'INVALID_CONFIG', 'Invalid public collaboration API URL', 500); }
    requireCondition(['http:', 'https:'].includes(publicUrl!.protocol) && !publicUrl!.username && !publicUrl!.password && !publicUrl!.search && !publicUrl!.hash, 'INVALID_CONFIG', 'Invalid public collaboration API URL', 500);
  }
  const publisherIds = (env.STUDIO_PUBLISHER_USER_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  requireCondition(publisherIds.every(x => /^[1-9][0-9]*$/.test(x) && Number.isSafeInteger(Number(x))), 'INVALID_CONFIG', 'Publisher IDs must be positive Studio user IDs', 500);
  let desktopUpdate: Config['desktopUpdate'];
  if (env.DESKTOP_UPDATE_MIN_VERSION) {
    requireCondition(parseVersion(env.DESKTOP_UPDATE_MIN_VERSION) !== undefined, 'INVALID_CONFIG', 'DESKTOP_UPDATE_MIN_VERSION must be a semantic version', 500);
    if (env.DESKTOP_UPDATE_APP_LINK) {
      let link: URL;
      try { link = new URL(env.DESKTOP_UPDATE_APP_LINK); } catch { requireCondition(false, 'INVALID_CONFIG', 'Invalid DESKTOP_UPDATE_APP_LINK', 500); }
      requireCondition(link!.protocol === 'https:' && !link!.username && !link!.password, 'INVALID_CONFIG', 'DESKTOP_UPDATE_APP_LINK must be an HTTPS URL without credentials', 500);
    }
    desktopUpdate = { minVersion: env.DESKTOP_UPDATE_MIN_VERSION, title: env.DESKTOP_UPDATE_BLOCK_TITLE, detail: env.DESKTOP_UPDATE_BLOCK_DETAIL, appLink: env.DESKTOP_UPDATE_APP_LINK };
  }
  return { publisherIds: new Set(publisherIds.map(Number)), publicationTokenSecret: env.PUBLICATION_TOKEN_SECRET, publicApiUrl: env.PUBLIC_API_URL?.replace(/\/$/, ''), databaseUrl: env.DATABASE_URL, databaseSsl: env.PG_SSL === 'require', gitlabUrl: url!.origin, gitlabToken: env.SEI_GITLAB_TOKEN || undefined, host: env.HOST ?? '127.0.0.1', port, desktopUpdate };
}
