# Security policy

## Reporting a vulnerability

Report a vulnerability privately through [GitHub's private vulnerability reporting](https://github.com/routecraftjs/routecraft/security/advisories/new). Do not open a public issue, pull request or discussion for it.

Include the affected package and version, what an attacker can do, and the smallest route or configuration that shows it. We acknowledge a report within three working days, keep you informed while we fix it, and credit you in the advisory unless you ask us not to.

## Supported versions

Routecraft is pre-1.0. Security fixes land in the latest release of each `@routecraft/*` package and are not backported to earlier minors. Upgrade to the latest release to receive them.

## What every change is checked for

- **Container scan.** Every pull request that touches the packages builds the project `create-routecraft` scaffolds, with the `Dockerfile` it ships, and scans the image with [Trivy](https://trivy.dev). A second profile installs every optional adapter dependency at the newest version its declared range allows. A fixable HIGH or CRITICAL vulnerability, or a secret in the image, fails the change. The docs site's image is scanned the same way.
- **SBOM.** The same run writes a CycloneDX SBOM for the starter image and for the adapter dependency tree, kept as the `sbom` artifact of the run.
- **Code scanning.** CodeQL analyses the TypeScript on every pull request and weekly.
- **Accepted findings.** A finding that cannot be fixed from this repository yet is recorded in [`.trivyignore.yaml`](./.trivyignore.yaml) with the reason and an expiry of at most 30 days, after which the scan fails again.
- **Publishing.** npm packages are published from CI with provenance through npm trusted publishing, and every GitHub Action is pinned to a commit.
