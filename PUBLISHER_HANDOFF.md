# Protected publisher handoff — owner decision required

## Current full-cycle integration (2026-11-27)

The sections below record earlier decisions. The current owner-approved design
is one official GitHub login on the owner's Windows computer, credentials only
in Windows Credential Manager, and subsequent publication from the existing XRS
administrative editor through versioned, hash-checked local stdio. No VPS or
broker is required. Environment approval uses the owner's normal authenticated
API permission; protection is not bypassed. The full client candidate is
`002-421/-main`, branch `codex/xrs-template-publishing-full-086`.

Root-chain delivery, historical package authorization, exact signed publication
receipts, replay reconciliation and safe cleanup are implemented and tested with
temporary keys. This does not mean the production trust ceremony or a real
GitHub Test publication has occurred. Follow the single integrated RC acceptance
checklist in the client; do not request separate intermediate user acceptance.

`Activate-Stable-After-Acceptance.cmd` is an explicit, owner-only action after
that acceptance and separately authorized live Test delivery to two Windows
clients. It checks protected setup, the pinned setup anchor/chain, public root,
real signed Test packages and the owner's typed confirmation before writing the
Stable flag. XRS and CI never call it. Do not run it during development or send
credentials/private keys through chat. No activation is authorized by this PR.

This document describes a reviewable procedure. It does not provision a service,
generate working keys, grant permissions, enable a channel or publish a catalog.

## Changes ready for review

The feature branch adds schema-2 revision history and records the authenticated
GitHub Environment reviewer. Merge requires a separately approved PR, successful
`validate` and the existing protected-branch checks. No protection bypass is used.
The application can prepare a PIN-protected local Draft and export its unsigned
proposal. A PIN or proposal-supplied medical reference is not remote authority.

## Keys and trust ceremony (not yet authorized)

1. Owner chooses the key custodian, isolated machine/hardware and recovery holders.
   Generate three distinct Ed25519 keys: offline root, online test, online Stable.
   Do not generate them on a doctor's computer or in a normal CI job.
2. Retain the root private key offline under the custodian's recovery policy. Store
   test and Stable private keys only as Environment-scoped signing secrets. Review
   the exact protected workflow SHA before permitting a job to use those secrets.
3. Review/publish public root metadata and embed that trust anchor in XRS. Implement
   authenticated sequential root delivery and test expiry, rotation and online-key
   revocation before enabling downloads. Never use trust-on-first-use.
4. Keep the provisioning flag false until all gates and end-to-end tests pass.
   Use only synthetic content and the test key for the first publication.

## Decision update: no-VPS audit

The owner rejects opening GitHub for sign-in even once per XRS session. Device
Flow could support a no-VPS GitHub App client with memory-only expiring user
access tokens and explicit Environment review through the normal API, but that
UX is not acceptable under the current requirement. Do not implement or enable
it as if approved. See [the audit and A/B/C comparison](ARCHITECTURE_NO_VPS_RU.md).

A managed serverless broker is a fallback for separate design approval, not an
already selected deployment or an excuse to bypass the owner reviewer. It needs
an agreed external identity provider and a valid authorized reviewer context;
an installation token alone cannot stand in for the required human. A one-time
GitHub authorization/bootstrap may still be necessary. No new keys or credentials
have been provisioned by this audit.

## Trusted service for publishing from XRS (conditional fallback)

Owner must select an HTTPS service host, identity provider and authorized medical
editor identities. Suggested contract: OIDC Authorization Code with PKCE in the
system browser, state/nonce validation and short-lived, audience-bound access
credentials. The service validates issuer, subject, audience, expiry, replay
protection and server-side editor membership; it never trusts the PIN or a role
claim supplied by XRS. Long-lived personal GitHub tokens are forbidden in XRS.

The service revalidates canonical proposal size/schema/base hash, stable field IDs,
medical approval reference and privacy checks. Bind approval to the proposal hash,
channel and base revision, with an idempotency key. Use a narrowly installed GitHub
App and short-lived installation credentials only on the service to submit a PR
and dispatch the existing main-only publisher. Retain the owner Environment review
until an explicitly approved protection model replaces it. Do not bypass main,
required checks, Environment review or catalog signing. Surface `awaiting review`,
`published`, or the safe failure code and run URL to XRS; do not report publication
when merely queued. Never overwrite a release/tag/previous revision.

A separate review must specify service persistence/encryption, audit retention,
allowed identities, incident response, credential revocation and exact least
GitHub permissions. No service has been deployed by this branch.

## Acceptance before production

Publish one synthetic proposal to the protected test channel, without Codex as an
operator. On two isolated XRS installations confirm the same signed Active index,
Archived selection without PIN, unchanged old reports, independent rollback,
revoked revision denial, offline cache and cold restart. Complete Windows CI and
actual Word exchange validation. Verify production root delivery/revocation. Only
then request separate permission to enable and release XRS Stable.

## Confirmed owner scope for XRS 0.4.86 (2026-11-27)

The clinic server is not available for this release. GitHub Releases and the
protected GitHub Actions workflow in this repository are the chosen initial
catalog distribution and publication platform. During the first release,
manual publication via the approved GitHub workflow is acceptable; there is
no requirement to implement direct in-XRS GitHub sign-in or a separately hosted
publisher in this pull request. This does **not** turn the disabled in-XRS
Publish control into an operational feature.

This pull request is preparation for owner review only. It does not authorize
merging, provisioning production signing keys, relaxing branch protection or
Environment reviews, enabling the production channel, or publishing a catalog.
After a separately approved merge, the owner must complete protected one-time
trust setup, confirm the test signing environment, and review the synthetic
GitHub test publication before production activation. The public root and
private signing material remain separate; do not place private keys in source
or the physician application.
