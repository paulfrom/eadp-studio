# Desktop source preparation

The product repository stores the fixed upstream source contract in `../release.lock.json`. DSH source itself is downloaded from the exact commit archive into the ignored `.local/upstream/dsh/` directory. It is not a Git submodule or nested Git checkout. Product-specific build scripts and necessary upstream patches belong in this `build/` directory; no product patch or distribution pipeline is implemented by this layout change.

From the product repository root:

```sh
node scripts/fetch-dsh.mjs --archive-only
node scripts/fetch-dsh.mjs
```

The first command downloads or reuses the fixed archive, checks its SHA256, archive paths, relative symlink boundaries, critical file hashes and package metadata. The default command additionally extracts to a temporary sibling directory and publishes the checked source tree by same-filesystem rename. It requires Node's built-in fetch and system `tar`. It does not install dependencies. No override URL, mutable branch, replacement source or fallback is accepted.

The upstream package declares Node `^22.19.0 || >=24.0.0`, `pnpm@11.28.5` and TypeScript `^6.0.3`; its `pnpm-lock.yaml` is part of the source archive. Use the upstream package manager and lockfile when preparing dependencies. Studio's root workspace and the prototype template have independent toolchain boundaries.

The fixed archive has 17,129 entries, including 14 real relative symbolic links. Windows must already permit creation of symbolic links. This workstation currently returns Node `EPERM` and Windows tar `Invalid argument` for `CLAUDE.md -> AGENTS.md`, including outside the sandbox. Archive-only verification can succeed; complete source preparation cannot succeed here until that environment capability is supplied. The fetch command does not change Windows settings or replace symlinks with copies, and it does not publish an incomplete tree.

The archive cache is `.local/upstream/dsh-<commit>.tar.gz`; successful extraction also writes `.local/upstream/dsh.source.json`. Existing source is never overwritten: its receipt and critical hashes must match. This existing-directory check is not a full audit of every source file. A changed or unknown source tree must be inspected explicitly. Concurrent fetches are rejected by the `.local/upstream/.dsh-fetch.lock` directory. Incomplete downloads/extractions remain in `.dsh-fetch-*` directories for inspection. If a process is killed, inspect and manually remove its empty lock directory before retrying. The script performs no recursive deletion.

`release.lock.json` currently records only observed source requirements and source-layout verification. Target-release plugin compatibility, dependency installation, native Windows build, signing, installation, lifecycle and distribution acceptance remain unverified. Neither an archive-only pass nor source extraction is a G0 or release acceptance result.
