import type { Config } from './config.js';

export interface SemVer { major: number; minor: number; patch: number; prerelease: string[] }
export type DesktopUpdateDecision =
  | { code: 0; data: { biz_code: 0; biz_data: null } }
  | { code: 40005; data: { show_content: { title?: string; detail?: string }; desktop_app_link?: string } };

export function parseVersion(value: string): SemVer | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ? match[4].split('.') : [] };
}

export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === undefined || y === undefined) return (x === undefined ? -1 : 1);
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function decideDesktopUpdate(config: Config, headers: Record<string, unknown>): DesktopUpdateDecision {
  const policy = config.desktopUpdate;
  const clear: DesktopUpdateDecision = { code: 0, data: { biz_code: 0, biz_data: null } };
  if (!policy) return clear;
  const client = parseVersion(String(headers['x-client-version'] ?? ''));
  if (client && compareVersions(client, parseVersion(policy.minVersion)!) >= 0) return clear;
  const show_content: { title?: string; detail?: string } = {};
  if (policy.title) show_content.title = policy.title;
  if (policy.detail) show_content.detail = policy.detail;
  const data: { show_content: { title?: string; detail?: string }; desktop_app_link?: string } = { show_content };
  if (policy.appLink) data.desktop_app_link = policy.appLink;
  return { code: 40005, data };
}
