import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.js';
import { compareVersions, decideDesktopUpdate, parseVersion } from './desktop-update.js';

const base = { DATABASE_URL: 'postgresql://synthetic', PG_SSL: 'disable', GITLAB_URL: 'http://gitlab.test', GITLAB_ALLOW_HTTP: 'true' };

test('parseVersion accepts semantic versions with optional prerelease and build metadata', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion('0.2.1-alpha.2'), { major: 0, minor: 2, patch: 1, prerelease: ['alpha', '2'] });
  assert.equal(parseVersion('0.2.1+build.5')!.prerelease.length, 0);
  assert.equal(parseVersion('v1.2'), undefined);
  assert.equal(parseVersion('1.2.x'), undefined);
  assert.equal(parseVersion(''), undefined);
});

test('compareVersions follows semver precedence including prerelease ordering', () => {
  const v = (s: string) => parseVersion(s)!;
  assert.ok(compareVersions(v('1.2.3'), v('1.2.10')) < 0);
  assert.ok(compareVersions(v('2.0.0'), v('1.9.9')) > 0);
  assert.equal(compareVersions(v('1.2.3'), v('1.2.3')), 0);
  assert.ok(compareVersions(v('1.0.0'), v('1.0.0-alpha')) > 0, 'release outranks prerelease');
  assert.ok(compareVersions(v('1.0.0-alpha.1'), v('1.0.0-alpha.2')) < 0);
  assert.ok(compareVersions(v('1.0.0-alpha'), v('1.0.0-alpha.1')) < 0, 'shorter prerelease has lower precedence');
  assert.ok(compareVersions(v('1.0.0-1'), v('1.0.0-alpha')) < 0, 'numeric identifier ranks below alphanumeric');
});

test('an unconfigured policy always returns the exact clear decision', () => {
  const config = loadConfig(base);
  assert.deepEqual(decideDesktopUpdate(config, {}), { code: 0, data: { biz_code: 0, biz_data: null } });
  assert.deepEqual(decideDesktopUpdate(config, { 'x-client-version': '0.0.1' }), { code: 0, data: { biz_code: 0, biz_data: null } });
});

test('clients at or above the minimum version are cleared', () => {
  const config = loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: '1.2.0' });
  assert.deepEqual(decideDesktopUpdate(config, { 'x-client-version': '1.2.0' }), { code: 0, data: { biz_code: 0, biz_data: null } });
  assert.deepEqual(decideDesktopUpdate(config, { 'x-client-version': '1.3.0-alpha.1' }), { code: 0, data: { biz_code: 0, biz_data: null } });
});

test('clients below the minimum version or with an unparsable version are blocked', () => {
  const config = loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: '1.2.0', DESKTOP_UPDATE_BLOCK_TITLE: '请升级', DESKTOP_UPDATE_BLOCK_DETAIL: '详细说明' });
  assert.deepEqual(decideDesktopUpdate(config, { 'x-client-version': '1.1.9' }), { code: 40005, data: { show_content: { title: '请升级', detail: '详细说明' } } });
  assert.deepEqual(decideDesktopUpdate(config, { 'x-client-version': 'garbage' }).code, 40005);
  assert.deepEqual(decideDesktopUpdate(config, {}).code, 40005, 'missing version header fails closed');
});

test('an optional HTTPS app link is attached to the block decision', () => {
  const config = loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: '1.0.0', DESKTOP_UPDATE_APP_LINK: 'https://download.example.com/eadp' });
  assert.deepEqual(decideDesktopUpdate(config, { 'x-client-version': '0.9.0' }), { code: 40005, data: { show_content: {}, desktop_app_link: 'https://download.example.com/eadp' } });
});

test('config load rejects an invalid minimum version or a non-HTTPS app link', () => {
  assert.throws(() => loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: 'v1.2' }), /DESKTOP_UPDATE_MIN_VERSION/);
  assert.throws(() => loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: '1.0.0', DESKTOP_UPDATE_APP_LINK: 'http://100.119.183.44/download' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...base, DESKTOP_UPDATE_MIN_VERSION: '1.0.0', DESKTOP_UPDATE_APP_LINK: 'not-a-url' }), /DESKTOP_UPDATE_APP_LINK/);
});
