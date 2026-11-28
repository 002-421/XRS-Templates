# Official catalog 1.0.0 bootstrap

The owner authorized publication of the exact 113-template catalog from XRS
Stable commit 658b96d19472e7cd87857c655b9dae96bf86383d. No workstation state,
overrides, Drafts or old publication request may enter this release.

The fixed descriptor in catalog-bootstrap/1.0.0.json binds the new independent
operation b063498e-1094-415b-8d19-fef5345d35a9, immutable source hash,
request hash and both artifact hashes. The audit reads Git blobs from the fixed
Stable SHA, not the mutable checkout. It validates all native fields, document
structure, per-template baseline hashes and privacy checks (55 MRI, 58 CT,
eight Spine v8 templates and forty native Spine fields).

On 2026-11-28 the owner separately authorized retiring only the unpublished tag
reservation xrs-templates-v1.0.0 / object 2a42d1d53f765b467554ae95063f2cf422c03485.
The old operation is not resumed. Its five empty draft releases must remain
unchanged. The bootstrap checks their IDs, emptiness and reservation metadata
before retirement, and verifies the draft records again afterwards. There is
no force-push or branch, Environment, Secret or protection change.

The manually dispatched catalog-088-acceptance workflow requires successful
complete Windows validation of the exact XRS candidate SHA. It uses the existing
XRS OAuth Device Flow and real Windows DPAPI. No token passes through renderer,
workflow inputs or artifacts. A Node launcher waits for Electron and requires
explicit evidence, rejecting exit-zero runs without results.

First it publishes the clearly labeled synthetic prerelease
xrs-templates-v0.0.88. Both actual assets are verified and installed using two
isolated instances of the production downloader. Their explicit source is the
prerelease URL. The production latest pointer must remain unchanged. No source
URL validation or trust policy is bypassed.

Only after this test succeeds does the same authorized main process retire the
approved reservation and publish the new official 1.0.0 operation. Existing
public releases are immutable. The operation descriptor is fixed across retries.
The production public index and archive are downloaded anonymously, installed
in two independent clean stores, checked against the immutable content hash,
rolled back and reinstalled. Sentinels for documents, local templates and
settings must survive. Offline persistence uses an explicit simulated network
failure after real public installation and is reported separately.

These are isolated Windows downloader instances, not the unavailable owner's
physical computer. No XRS application Stable release or user RC is published.
