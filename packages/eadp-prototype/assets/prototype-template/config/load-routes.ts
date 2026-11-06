import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

interface PrototypeRoute {
  path: string;
  component?: string;
  title?: string;
  redirect?: string;
  routes?: PrototypeRoute[];
}

const routeKeys = new Set(['path', 'component', 'title', 'redirect', 'routes']);
const routePath = /^(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z_][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z_][A-Za-z0-9_]*))*|\/|\*)$/;

function regularFile(root: string, filename: string): void {
  const rel = relative(root, realpathSync.native(filename));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Prototype route file is outside its source boundary');
  }
  for (let current = filename; current !== root; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('Prototype route file link is forbidden');
  }
  if (!statSync(filename).isFile()) throw new Error('Prototype route requires a regular file');
}

/** Data is parsed, never imported as an executable Umi configuration module. */
export function loadPrototypeRoutes(projectRoot: string): PrototypeRoute[] {
  const root = realpathSync.native(projectRoot);
  const filename = resolve(root, 'config/routes.json');
  regularFile(root, filename);
  if (statSync(filename).size > 256 * 1024) throw new Error('Prototype route data is too large');
  const value: unknown = JSON.parse(readFileSync(filename, 'utf8'));
  const seen = new Set<string>();
  let count = 0;

  function routes(input: unknown, depth: number): PrototypeRoute[] {
    if (!Array.isArray(input) || input.length === 0 || depth > 16) throw new Error('Prototype routes must be a non-empty bounded array');
    return input.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Prototype route must be an object');
      const item = entry as Record<string, unknown>;
      if (++count > 1000 || Object.keys(item).some(key => !routeKeys.has(key))) throw new Error('Prototype route contains unsupported fields');
      if (typeof item.path !== 'string' || !routePath.test(item.path) || seen.has(item.path)) throw new Error('Prototype route path is invalid or duplicated');
      seen.add(item.path);
      const route: PrototypeRoute = { path: item.path };
      if ('title' in item) {
        if (typeof item.title !== 'string' || item.title.length > 200 || Array.from(item.title).some(character => character.charCodeAt(0) < 32)) throw new Error('Prototype route title is invalid');
        route.title = item.title;
      }
      if ('redirect' in item) {
        if (typeof item.redirect !== 'string' || !routePath.test(item.redirect) || item.redirect === '*' || 'component' in item || 'routes' in item) throw new Error('Prototype route redirect is invalid');
        route.redirect = item.redirect;
      } else {
        if ('component' in item) {
          if (typeof item.component !== 'string' || !/^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(item.component)) throw new Error('Prototype route component must be a local page');
          const pages = resolve(root, 'src/pages');
          const base = resolve(pages, item.component.slice(2));
          const candidates = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];
          const page = candidates.map(suffix => `${base}${suffix}`).find(candidate => {
            try { return statSync(candidate).isFile(); } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
              throw error;
            }
          });
          if (!page) throw new Error('Prototype route component does not exist');
          regularFile(root, page);
          regularFile(pages, page);
          route.component = item.component;
        }
        if ('routes' in item) route.routes = routes(item.routes, depth + 1);
        if (!route.component && !route.routes) throw new Error('Prototype route requires a page, children or redirect');
      }
      return route;
    });
  }
  return routes(value, 0);
}
