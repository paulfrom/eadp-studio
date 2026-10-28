# Prototype merge verifier image inputs

The collaboration image builds a standalone Git executable for the prototype
merge verifier. The source is the upstream `git-2.56.0.tar.xz` release at
`https://www.kernel.org/pub/software/scm/git/`. Its expected SHA-256 is in
`git-verifier.sha256`; the Dockerfile checks the archive before extracting it.
The digest was obtained from Git's published `sha256sums.asc`. The signature on
that checksum list has not been independently verified in this development
round; the checked-in hash is therefore a pinned input, not a signature attestation.

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
the image includes `util-linux` from the dated snapshot. These are not a total
disk quota or a container-level resource boundary. Their availability and
enforcement, cleanup of temporary objects after a process crash, and
Windows/Linux merge-tree agreement remain deployment and acceptance work. No
build or runtime validation has been performed for these image changes in this
round.
