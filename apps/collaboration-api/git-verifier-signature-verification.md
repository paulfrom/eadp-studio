# Git 2.56.0 source signature verification

Verified on 2026-10-28 on Windows with the existing
`D:\devtools\Git\usr\bin\gpg.exe` (GnuPG 2.4.7, libgcrypt 1.9.4).
No dependency was installed; no global keyring or trust configuration changed.
The Docker build still checks the fixed SHA-256 and does not gain a GnuPG runtime
dependency.

## Sources and signer identity

- Archive: <https://www.kernel.org/pub/software/scm/git/git-2.56.0.tar.xz>
- Detached developer signature: <https://www.kernel.org/pub/software/scm/git/git-2.56.0.tar.sign>
- Public key: `junio-gpg-pub` from the official Git repository
  <https://github.com/git/git>. The fetched tag object was
  `dd20f6ea53bf6828baba3e2f279bf633eaae6815`; its target key blob was
  `debb772bfc2bfedbfd5830dbe2c1c149dbf054e9`.
- Primary fingerprint independently matches the kernel.org
  [Junio key analysis](https://www.kernel.org/doc/wot/junio.html):
  `96E07AF25771955980DAD10020D04E5A713660A7`.
- Signing subkey in the fetched key:
  `E1F036B1FEE7221FC778ECEFB0B5E88696AFE6CB`, expiring 2028-01-11.
  The historical kernel.org analysis lists an older subkey expiry; the current
  key from the official Git repository carries the renewed expiry.

Kernel.org [explains](https://www.kernel.org/category/signatures.html#kernel-org-checksum-autosigner-and-sha256sums-asc)
that its checksum autosigner establishes mirror consistency and does not replace
developer signatures. The downloaded `sha256sums.asc` requested the separate key
`B8868C80BA62A1FFFAF5FDA9632D3A06589DA6B1`; it was not imported or trusted.
The release signature below authenticates the actual decompressed tar instead.

## Reproduction

Use a new disposable directory, existing Git/GnuPG and Python's standard-library
`lzma`. Downloads and Git fetch are read-only remote operations. These commands
never import into the user's default keyring. If Git requires the operating
system HTTP proxy, pass its configured proxy with a per-command `-c http.proxy=...`;
do not change global Git settings.

```powershell
$proof = Join-Path $env:TEMP ('eadp-git-signature-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $proof | Out-Null
$gitRoot = Split-Path (Split-Path (Get-Command git).Source)
$gpg = Join-Path $gitRoot 'usr/bin/gpg.exe'
$keyRepo = Join-Path $proof 'git-key.git'
git init --bare $keyRepo
git -C $keyRepo fetch --depth=1 https://github.com/git/git.git refs/tags/junio-gpg-pub:refs/tags/junio-gpg-pub
git -C $keyRepo rev-parse refs/tags/junio-gpg-pub
git -C $keyRepo rev-parse 'junio-gpg-pub^{}'
git -C $keyRepo cat-file blob junio-gpg-pub | Set-Content -Encoding ascii (Join-Path $proof 'junio-gpg-pub.asc')
& $gpg --no-options --no-autostart --homedir $proof --batch --show-keys --with-fingerprint --with-subkey-fingerprint (Join-Path $proof 'junio-gpg-pub.asc')
# Check the primary and subkey fingerprints above before importing.
& $gpg --no-options --no-autostart --homedir $proof --batch --import (Join-Path $proof 'junio-gpg-pub.asc')
Invoke-WebRequest 'https://www.kernel.org/pub/software/scm/git/git-2.56.0.tar.xz' -OutFile (Join-Path $proof 'git-2.56.0.tar.xz')
Invoke-WebRequest 'https://www.kernel.org/pub/software/scm/git/git-2.56.0.tar.sign' -OutFile (Join-Path $proof 'git-2.56.0.tar.sign')
Get-FileHash -Algorithm SHA256 (Join-Path $proof 'git-2.56.0.tar.xz')
python -c "import lzma,shutil,sys; from pathlib import Path; p=Path(sys.argv[1]); s=lzma.open(p/'git-2.56.0.tar.xz','rb'); o=open(p/'git-2.56.0.tar','wb'); shutil.copyfileobj(s,o); s.close(); o.close()" $proof
& $gpg --no-options --no-autostart --homedir $proof --batch --no-auto-key-retrieve --status-fd 1 --verify (Join-Path $proof 'git-2.56.0.tar.sign') (Join-Path $proof 'git-2.56.0.tar')
# Require exit 0 and the exact VALIDSIG primary/subkey fingerprints below.
```

## Actual result

The archive SHA-256 was
`26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3`,
matching `git-verifier.sha256`. The decompressed tar SHA-256 was
`21610fc67a39c6724b96001665baf60bfaf19191b0aeeb33764dfcd2d020f187`;
the signature file SHA-256 was
`bee7d2f96844063557b07b43811d81e1fc54563e0da2c36a975dfd432b196a5c`.

Verification returned exit **0** and these status records:

```text
[GNUPG:] GOODSIG B0B5E88696AFE6CB Junio C Hamano <gitster@pobox.com>
[GNUPG:] VALIDSIG E1F036B1FEE7221FC778ECEFB0B5E88696AFE6CB 2026-09-28 1790571422 0 4 0 1 8 00 96E07AF25771955980DAD10020D04E5A713660A7
[GNUPG:] TRUST_UNDEFINED 0 pgp
```

GnuPG's local trust database had no personal certification of this key, so it
also reported the expected trust warning. Identity here is grounded in the
official Git key publication and the matching independently published kernel.org
primary fingerprint; this is not a claim of a locally established web of trust.
This verifies the fixed source archive, not the compiler packages, resulting Git
binary, application image, container execution or desktop workflow.
