# XRS medical template catalog

Development infrastructure for independent, signed medical template updates.
**Not enabled in production XRS. No signed Stable catalog has been published.**

The [Simplified Publishing v1 audit and proposed PR-free data flow](SIMPLIFIED_PUBLISHING_V1_AUDIT_RU.md)
records the current infrastructure and the owner decision needed for administrator
authentication. That design is not implemented or activated. The existing
PR-based procedure below still describes the current code.

Sources are sanitized snapshots of the already bundled XRS 0.4.83 catalog. They
retain permanent template IDs, service-field IDs, formatting and the existing
structural editable-highlight contract. The original XRS catalogs are unchanged.
Patient reports, doctor profiles, stamp images and signing keys do not belong here.

## Local preparation

Install Node.js 24, download/clone this repository, then run `npm ci --ignore-scripts`.
On Windows open `Start-Template-Admin.cmd`, then open the local address it prints.
Select a template, edit text, review the comparison and field list, enter the
medical approval reference, and download an unsigned `.xrsproposal`.
No JSON editing, checksum calculation or GitHub token is required in the tool.

This initial editor preserves existing formatting and treats native fields and
measurements as protected. Remapping native fields and full Word roundtrip are not implemented yet.
A new template/group can be cloned through the local UI; existing source IDs stay
untouched. Several prepared proposals can be published in one catalog workflow
by supplying their filenames separated by commas. An arbitrary
DOCX must not be treated as a publishable package. Unresolved Track Changes and
ambiguous XRS fields remain blockers in the existing XRS importer.

## Publication — currently blocked pending provisioning and acceptance

`validate-templates.yml` checks JSON Schema, canonical data, identifiers, field
contracts, original source hashes, known reference images and proposal structure.
Automatic checks cannot prove medical correctness or absence of every form of
personal data. A medical editor must approve each change.

`publish-catalog.yml` is initially disabled by the absent
`TEMPLATE_PUBLICATION_PROVISIONED=true` repository variable. It additionally requires
protected `catalog-test` / `catalog-stable` Environments, an authorized reviewer,
a trusted public root and a channel-specific signing secret. Do not remove these
gates to get a successful run.

After provisioning and acceptance, upload an approved proposal into `incoming/`
through a reviewed PR, run the publication workflow on `main`, select the channel,
and have the authorized editor approve the Environment deployment. The workflow
signs data, creates an immutable tag, prepares a draft GitHub Release, verifies
uploaded digests, makes it public and verifies downloaded hashes. It never changes
an existing tag. Test Releases are prereleases and never become the latest Stable.

The local tool authenticates the current published channel before editing when a
public trust root is provisioned. The publisher independently restores the signed
current catalog and rejects stale proposals. Without a public root the tool can
only prepare draft baseline proposals; it cannot publish them.

No app release may claim this full workflow ready until a prepared change has been
published through the protected workflow and installed in two independent XRS
instances. Test content must stay in the isolated test channel.

See [Provisioning](PROVISIONING.md), [Security](SECURITY.md), and
[Administrator guide](ADMIN_GUIDE_RU.md).

## Windows setup wizard

On Windows 11 with Node.js 24+ and the official GitHub CLI installed, run
`Setup-XRS-Templates.cmd`. The wizard uses `gh auth login --web`; it never asks
for a GitHub password. It verifies repository admin access, `main` branch
protection, required `validate` status, the three existing protected Environments,
their owner reviewer and their `main` deployment policy. An API 403 is a stop
condition with a link to the relevant GitHub settings; the wizard does not edit
protection.

The wizard asks for the explicit phrase `CREATE THREE KEYS` before it generates
three independent Ed25519 key pairs. It stores only the test and Stable private
keys in an owner-only Windows ACL directory outside the repository. The root
private key is written only into a passphrase-encrypted backup on a different
USB/SD/MMC medium; Windows disk metadata must confirm it is a distinct physical
disk from the local key directory. The wizard reads the backup back and verifies
the key ID. Test and Stable
Environment secrets are sent with `gh secret set` on stdin, never as arguments or
temporary transfer files. After GitHub confirms each secret exists, its temporary
local private-key file is deleted; a missing remote secret after that point is a
manual recovery blocker, not a reason to silently generate a replacement.
Secret values are not displayed or logged. Existing secrets are never overwritten
automatically.

The public `trust/root.json` is added on a separate branch and pull request.
The wizard never writes to `main`, never merges, and never sets
`TEMPLATE_PUBLICATION_PROVISIONED=true`. After the owner merges the root PR, a
second run can enable only `TEMPLATE_TEST_PUBLICATION_PROVISIONED` following an
explicit confirmation. The publisher workflow keeps the Stable gate independent;
it can be activated only after test acceptance and owner review.

The wizard records non-secret progress under `%LOCALAPPDATA%\XRS-Templates-Setup`
so it can resume without generating replacement keys. If artifacts are partial
or do not match, it stops for owner review. The root private key is not placed in
Git, Actions Secrets, releases, or XRS. No production keys are generated merely
by building or testing this project.

The wizard provisions GitHub signing material; it does not itself publish a
catalog or certify client installation. Authenticated root delivery/rotation and
revocation, plus two independent Windows XRS installations, remain required
before enabling the Stable channel.
