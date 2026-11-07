# Public npm distribution and headless tests

Prepared **31 October 2026**. The plugin code is Apache-2.0, with OrgSDK
attribution in `NOTICE` and the trademark boundary in `TRADEMARKS.md`. Preparation
does not change repository visibility or publish a package. The source root
stays `private: true` to prevent publishing development files by accident.

## Dependencies and verification

Install from this repository's lockfile:

```sh
bun install --frozen-lockfile
bun run check
bun run typecheck
bun run test
bun audit
bun run version-guard
bun run validate
bun run package
bun run build:npm
bun run test:executor
bun run test:registration
```

The authoring API is downloaded from npm as `@orgsdk/plugins@0.2.2`; the packager
and real execution engine are `@orgsdk/executor@0.1.0` from npm. Neither command
uses a sibling platform/toolkit checkout, a Git dependency, or `bun link`. Node
22.22.0+ and Bun 1.4.0 are required; CI checks Node 22.22.1 and 24. Browser plugins
also require Chromium and system libraries matching their Playwright version:

```sh
bunx --no-install playwright install --with-deps chromium
```

`package` recreates `dist/`, so run it before `build:npm`. The latter produces
`dist/npm/`: the ESM entry, pinned manifest/catalogue, complete third-party
notices, Apache licence, attribution, trademark terms and public npm metadata.
JavaScript dependencies are embedded; Chromium remains an external prerequisite.
The versioned `package_url` points to the npm entry through jsDelivr and the
executor verifies its SHA256 digest. These URLs become available after an
authorised npm publication; they are not live release receipts.

`test:executor` packs and extracts the exact npm payload outside the checkout.
It starts with an empty executor store, serves those extracted bytes at the
versioned npm URL through a strict fixture, verifies the digest, loads the real
factory and executes every advertised function with named arguments. It checks
credential denial and absence, and bounded/redacted transport errors where
applicable. Google SDK native HTTP is intercepted with Nock. Browser tests use
owned headless Chromium profiles and a loopback-only CDP site. All credentials,
responses and model outputs are synthetic; unexpected provider traffic fails.

Native OAuth fixtures use precisely `{source: "byo", secret_accessToken}`. The
host owns client secrets, refresh and token rotation. Facebook's `pageId` is
plugin configuration; its page token is resolved using the supplied user access
token. First-party relay credentials are unsupported. Other token providers
receive their stored secret record. Xero and Zendesk currently use explicitly
managed OAuth access tokens; the published host has no native connect/refresh
flow for those providers. Multi-customer Zendesk use requires an approved global
OAuth client, independently of opening this plugin's source.

`test:registration` downloads `@orgsdk/cli@0.1.0` from npm into temporary storage,
starts it with an isolated home/database and Node-only PATH, completes setup and
login, and registers the generated external catalogue release in a new project.
It checks version, digest and package URL through the real tRPC endpoint. It
does not use a personal installation. Installing npm files alone does not
register a plugin: a release catalogue must be configured in OrgSDK and its
release added to the project. These tests establish packaging, registration and
execution contracts; provider app approval and live account permissions still
need an authorised integration check.

Retain the exact tested tarball with:

```sh
NPM_TEST_ARTIFACT_DIR=artifacts bun run test:executor
```

## Direct trusted publishing

Updated **7 November 2026**. `publish-npm.yml` verifies source, dependency audit,
all exported functions in the exact npm tarball, and fresh host registration.
It publishes only the retained verified tarball. Source roots stay private npm
packages; only the generated payload is released.

Configure each package's npm trusted publisher with its exact `OrgSDK` repository,
workflow filename `publish-npm.yml`, environment `npm-publish`, and **Allow npm
publish**. Stage-only trust still requires interactive npm approval and is not
suitable for unattended releases. Use a protected GitHub environment to retain
release review. The publish job runs on a GitHub-hosted runner with Node 24,
pinned npm 12.0.2 and `id-token: write`; it needs no `NPM_TOKEN`.

Enable `ORGSDK_ENABLE_NPM_PUBLISH=true`, then push a matching `v<version>` tag
contained in `main`, or dispatch on `main` with `dry_run=false` and
`bootstrap_identity=false`. Default manual runs only verify and pack.
New npm trust must complete its first successful publication within two days.
After verifying OIDC publication, revoke obsolete publishing tokens and restrict
traditional token publishing in npm settings. Template publication remains blocked.

### One-time setup for a missing npm package

npm requires a package identity before trust can be configured. The separately
gated bootstrap job creates a metadata-only staged reservation at
`0.0.0-bootstrap.0`; npm exposes its own `0.0.0-stage` placeholder. **Never approve
or install the bootstrap reservation.** It contains no executable plugin code.

1. Create a temporary granular npm token with stage-only write access to the
   `@orgsdk` scope, no organization-management access, no 2FA bypass, and the
   shortest expiry. Store it securely as `NPM_BOOTSTRAP_TOKEN` in the protected
   `npm-publish` environment; never put credentials in source or chat.
2. Keep the normal release gate off. Enable `ORGSDK_ENABLE_NPM_BOOTSTRAP=true`
   and dispatch on `main` with `dry_run=false`, `bootstrap_identity=true`.
   The job requires registry 404 and derives only identity and legal metadata
   from the verified tarball. Existing packages must skip bootstrap.
3. Configure direct publishing trust for the resulting package, for example:
   `npm trust github @orgsdk/plugin-NAME --repo OrgSDK/orgsdk-plugin-NAME --file publish-npm.yml --environment npm-publish --allow-publish --yes`.
   Account authentication/2FA is required for this one-time configuration.
4. Disable the bootstrap gate and remove/revoke the temporary credential after
   all intended package identities are reserved. Enable normal OIDC publishing
   and dispatch the release with `bootstrap_identity=false`.
5. Verify the public npm version, integrity, provenance, and fresh consumer path.
   Only afterward reject the identified bootstrap stage; preserve the package.

GitHub source visibility, registry publication, catalogue promotion, website
deployment and live provider-account tests are separate results. Release tests
use synthetic provider fixtures, not live customer accounts.

References: [trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm trust](https://docs.npmjs.com/cli/v12/commands/npm-trust/), and
[staged publishing](https://docs.npmjs.com/staged-publishing/).

## Packaging compatibility and maintenance

The tracked executor patch fixes dependency-root discovery when export maps use
an unnamed intermediate `package.json`, and allows explicit
`licenses/<encoded-package-name>.txt` supplements when an npm archive omits its
licence. It also exports configuration schemas in input mode, so host registration accepts fields the executor supplies defaults for. Missing notices still fail the build. Google plugins retain upstream
licence texts and source receipts in `licenses/`. Runtime dispatch is unchanged.

OrgSDK grants Apache-2.0 for the specific embedded dependency loader incorporated
from executor 0.1.0 into these plugin distributions, as recorded in `NOTICE`.
That permission does not relicense the rest of the executor/platform. Third-party
licences remain intact. The published executor is used as development tooling.

Canonical scripts, patch, workflows and this guide live in
`OrgSDK/plugins/scripts/plugin-ci-templates/`. Each plugin retains independent
copies and its own fixture, so no sibling repository is needed in CI:

```sh
node scripts/sync-plugin-ci.mjs --root=..
node scripts/sync-plugin-ci.mjs --root=.. --check
```

When changing an advertised function, add successful headless coverage. Bump
matching package/manifest versions before releasing changed bytes; npm versions
cannot be overwritten.
