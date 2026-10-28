# Prototype merge verifier image inputs

The collaboration image builds a standalone Git executable for the prototype
merge verifier. The source is the upstream `git-2.56.0.tar.xz` release at
`https://www.kernel.org/pub/software/scm/git/`. Its expected SHA-256 is in
`git-verifier.sha256`; the Dockerfile checks the archive before extracting it.
The digest was initially obtained from Git's published `sha256sums.asc`. On
2026-10-28 the actual compressed archive matched that digest and its decompressed
tar passed Git maintainer Junio C Hamano's detached release signature check.
[Reproduction commands, fingerprints and actual GnuPG results](git-verifier-signature-verification.md)
record that verification and its trust boundary. The checksum autosigner is a
separate kernel.org service; its signature has not been verified and is not used
as a substitute for the developer signature.

The Node 22 Bookworm base is pinned by the Dockerfile to the Docker Hub
multi-platform index digest `sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d`.
At the time of the registry metadata read, its Linux amd64 manifest was
`sha256:ea11b74b986d520137cdef9a5346e447a00f275ecc4abc0055b7151226231e09`
and arm64 was `sha256:ceb43e5c219139035fb742900629e4abed89fe0997f7c03250c499e1f2710c9e`.
The Debian and security repository locations in `git-verifier.sources` use a
fixed snapshot timestamp and Debian archive signatures. The snapshot Release
file digests and individual compiler package digests are not separately pinned
in this repository. Updating any of these inputs requires an intentional review.

The runtime carries the Git binary and its GPL-2.0 license; it does not carry the
compiler or source archive. The resulting binary and final application image
digests are not known until the image is actually built and recorded. A version
string alone is not evidence of source provenance. The verifier invokes Git
through `prlimit`, with per-process CPU, address-space and file-size limits;
the image includes `util-linux` from the dated snapshot.

The checked-in Compose service also caps the whole API container at 2 GiB RAM
with no additional swap allowance, 2 CPUs and 128 processes. Its root filesystem
is read-only. The only application write area is a 512 MiB, non-executable
`/tmp` tmpfs owned by the image's `node` user (UID/GID 1000, asserted at build
time); `TMPDIR` explicitly directs Node and Git reconstruction there. The two
Git jobs can each address 512 MiB; the remaining container budget also covers
Node, network buffers and tmpfs pages. These are ceilings, not a guarantee that
every maximum-sized concurrent request can complete: exhaustion must fail the
verification rather than accept unverified content.

Normal request cleanup removes its temporary object directory in `finally`.
The tmpfs is discarded when the container stops, including after its main
process exits; it does not persist crash leftovers across container restarts.
Docker documents these [tmpfs lifecycle and memory semantics](https://docs.docker.com/engine/storage/tmpfs/)
and the [Compose resource controls](https://docs.docker.com/reference/compose-file/services/).
This boundary applies to the supplied Linux Compose deployment; a direct Node
launch does not inherit it.

The Compose settings and application write paths were reviewed, and the backend
typecheck and local unit tests ran on Windows. Docker is unavailable on that
machine: image construction, enforcement of these limits, Node/tsx startup on
the read-only filesystem, exhaustion and crash cleanup still require Linux
container execution. Compiler package digest inventory, built binary/image
digests and Windows/Linux merge-tree agreement
remain unverified. No deployment or real desktop acceptance is implied.
