# Prototype template source snapshot

This directory contains the Git-tracked source snapshot of `sei-blank-ts-app-2.0` at commit `53a59662cb405533f672c209f532124c63464b39`. It is the bundled prototype template source for EADP Studio, with its own `package.json` and toolchain. Keep it outside the product root workspace installation scope.

Tracked source files are imported without changing application logic or dependency versions. Text files are normalized to UTF-8 without BOM and LF; PNG/ICO assets retain their exact source bytes. The adjacent `prototype-template.manifest.json` records source and imported SHA256 hashes. The source `.env` is excluded; `.env.example` names its optional local settings without copying values. The tracked `.npmrc` was checked for authentication fields, URI credentials, local paths and private IP addresses before inclusion. Do not add credentials to it.

Existing package scripts include `start` (`MOCK=none umi dev`), `start:mock` (`MOCK=yes umi dev`), `build` (`ESLINT=none umi build`) and `lint`. The snapshot includes `config/`, `src/`, `public/`, `plugin.ts` and Docker configuration. Run tooling from this directory after dependencies and permitted registry access are available. No dependency installation, application build, lint run or browser verification has been performed for this import.

## Acceptance status

This is a source import, not a releasable template or a completed G0-3 acceptance result. The source snapshot has no dependency lockfile, no `AGENT.md`/`AGENTS.md` template rules, no `mock/` directory or test suite. The `start:mock` script alone does not prove isolated Mock behavior. Offline operation, outbound request blocking, rule enforcement, Windows/Linux runtime behavior and packaging remain unverified. Resolve those requirements in the planned template acceptance work before release.

Generated user-project prototype code belongs in the user project's `原型代码/` directory, outside this product repository. Runtime downloads, dependency directories and generated output do not belong in this source snapshot.
