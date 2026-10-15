# Desktop source preparation

The product repository stores the fixed upstream source contract in `../release.lock.json`. DSH source itself is downloaded from the exact commit archive into the ignored `.local/upstream/dsh/` directory. It is not a Git submodule or nested Git checkout. Product-specific build scripts and necessary upstream patches belong in this `build/` directory. [`prepare-studio-plugin.mjs`](prepare-studio-plugin.mjs) currently assembles the Studio plugin into an ignored build tree (`<primary checkout>/.local/build/dsh`), builds its two halves in the official Host-before-Client order, packs the plugin tarball, and replays anchored upstream edits:

- `apps/cli/package.json` — declare the plugin as a production dependency through [`desktop-plugin-edits.mjs`](desktop-plugin-edits.mjs), so official resolution includes it in the packaged CLI installation. No manual package-set root extension is used.
- `apps/desktop/scripts/prepare-package-set.ts` — accept `DSH_DESKTOP_PACKED_EXTRA` (the plugin tarball directory).
- `apps/desktop/src/project-manager.ts` — append the plugin to the shipped profile's `dsh.profile.bundles`.
- [`desktop-policy-edits.mjs`](desktop-policy-edits.mjs) — accept HTTP or HTTPS policy request origins at packaging and runtime, retaining URL structure checks and HTTPS login/download-page restrictions. The same edits update upstream tests and remove the former development-only loopback argument. They do not disable policy requests or replace unavailable decisions with successful responses.

The selected policy origin is an origin only, for example `http://100.119.183.44`; the runtime appends `/api/v0/check_client_update?scenario=launch`. For anonymous checks, the local Windows file selects `DSH_DESKTOP_AUTO_UPDATE_ENV=production` and `DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN`. Download-page origins can remain explicitly restricted to `https://www.zyjsm.top`. Packaging validates configuration without querying the service. Runtime launch starts the existing asynchronous check without awaiting it: connection errors, HTTP 404, invalid JSON/HTML and timeouts remain `unavailable`, preserving the current blocking state. A valid `40005` still blocks, and only a valid allow response clears it.

With the fixed source fetched and DSH build dependencies prepared, run `node --test tests/scripts/desktop-policy-edits.test.mjs` for generated-code and real loopback HTTP regression checks. The upstream `desktop-policy-environment.spec.ts` and `mandatory-update-policy.spec.ts` suites also run against the edited build tree. These focused results do not establish installed-app startup or full G0 acceptance.

It never writes to the verified source tree. Desktop packaging itself remains an upstream command and needs a Windows host for this Windows x64 product: `DSH_DESKTOP_PACKED_EXTRA=<shared>/.local/build/packed-studio pnpm run package:desktop:win:x64:unsigned`. The earlier unsigned package contained the minimal Host, so it does not verify the current complete Studio build. Installed-app and release qualification have separate evidence and limits in the [G0-1 handoff](../../../docs/development/handoffs/g0-1-minimal-slice.md).

Current assembly puts `@eadp/contracts` into the plugin's production dependencies and packs both product packages for the upstream package-set closure. It uses the official `compile-referenced-projects.ts libraries` and `scripts/build.ts --profile official --artifacts-only` entries. These retain checked Host-before-Client artifact builds while excluding the upstream aggregate script/test typecheck programs from packaging. Full repository checks remain separate.

Workspace reflection also uses the fixed upstream `WorkspaceAnalyzer.analyzeInBatches()` API, whose default is eight selected contributors per TypeScript program. The product patch changes only the generator's analyzer invocation and retains stable graph merging and all artifact emit/validation. This bounds reflection memory during the workspace bundler pass without increasing the Node heap. `studio-typert-edits.test.mjs` checks the fixed source anchor and compares direct/batched Host and Client fixture models; its semantic fixture requires the prepared DSH dependency tree.

The build rejects the former empty Host and missing generated Remote files, validates every template file, and records source and shipped output hashes in `studio-build.json`. The current source receipt must match when checking the prepared or extracted final app resources:

```powershell
node apps/desktop-distribution/build/verify-studio-distribution.mjs <dsh-resource-directory> <runtime/studio-tools-directory>
```

This also checks `@eadp/contracts` and TypeBox resolution from the actual production installation, plus every runtime file (including companion DLLs). To check an ASAR, first extract it using the existing Electron ASAR tooling, then pass the extracted `dsh` directory and the final adjacent `runtime/studio-tools` directory. Prepared-tree verification alone does not prove final ASAR contents or installed-app startup.

`prepareStudioTools(destination, archiveCache)` reuses only checksum-verified fixed `node.zip`, `pnpm.tgz` and `git.zip` archives. A corrupt cache fails closed. The official runtime preparation uses `apps/desktop/.desktop-build/downloads/studio-tools-archives`; a separate downloaded cache can be copied there before packaging. Host tool discovery follows the fixed official child argument contract: `argv[4]` is `primary-runtime`, and Studio uses its sibling `studio-tools` directory.

From the product repository root:

```sh
node scripts/fetch-dsh.mjs --archive-only
node scripts/fetch-dsh.mjs
```

The first command downloads or reuses the fixed archive, checks its SHA256, archive paths, relative symlink boundaries, critical file hashes and package metadata. The default command additionally extracts to a temporary sibling directory and publishes the checked source tree by same-filesystem rename. It requires Node's built-in fetch and system `tar`. It does not install dependencies. No override URL, mutable branch, replacement source or fallback is accepted.

The upstream package declares Node `^22.19.0 || >=24.0.0`, `pnpm@11.28.5` and TypeScript `^6.0.3`; its `pnpm-lock.yaml` is part of the source archive. Use the upstream package manager and lockfile when preparing dependencies. Studio's root workspace and the prototype template have independent toolchain boundaries.

The fixed archive has 17,129 entries, including 14 real relative symbolic links. Windows must already permit creation of symbolic links. After Developer Mode was enabled, full extraction passed on this workstation. The fetch script uses UTF-8 archive names and creates each real Windows symlink with its target type. It does not change Windows settings or replace symlinks with copies, and it does not publish an incomplete tree.

The archive cache is `.local/upstream/dsh-<commit>.tar.gz`; successful extraction also writes `.local/upstream/dsh.source.json`. Existing source is never overwritten: its receipt and critical hashes must match. This existing-directory check is not a full audit of every source file. A changed or unknown source tree must be inspected explicitly. Concurrent fetches are rejected by the `.local/upstream/.dsh-fetch.lock` directory. Incomplete downloads/extractions remain in `.dsh-fetch-*` directories for inspection. If a process is killed, inspect and manually remove its empty lock directory before retrying. The script performs no recursive deletion.

`release.lock.json` records source verification and dependency installation. Native build verification for the current complete Studio combination is pending, as are distribution qualification and the full target-release G0 POC. Neither archive verification, source extraction nor a successful development-machine build establishes clean-machine installation or release readiness.
