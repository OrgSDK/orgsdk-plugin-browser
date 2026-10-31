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

## Release workflow, prepared but disabled

CI checks author source, dependencies, npm execution and fresh registration.
`publish-npm.yml` verifies matching versions on a `v<version>` tag contained in
`main`, or a manual `main` run defaulting to dry run. It retains the tested npm
tarball and publishes those bytes only. Publication requires all of:

- Separate publication authority and a public GitHub repository matching the
  generated package's repository metadata. Local-only repositories still need
  their own independently owned remote and initial source publication.
- A protected `npm-publish` environment with maintainer review, scoped npm write
  credentials in `NPM_TOKEN`, and npm policy allowing CI publication.
- Explicit repository variable `ORGSDK_ENABLE_NPM_PUBLISH=true` and a release tag
  or a manual run with `dry_run=false`.

The job uses `--access public --provenance`, grants `id-token: write` only to the
publish job, and checks Apache/public metadata and the exact GitHub identity.
Template repositories/packages remain blocked until renamed. Do not enable any
release gate as part of local preparation. No remote, registry token, repository
visibility, environment or release setting is changed by these files. Consult
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/) before
the authorised release. npm publication and catalogue promotion are separate
operations; the historical `publish:catalog` command remains manual-only.

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
