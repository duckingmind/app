# Changelog

All notable changes to the Proxy App toolkit are documented here.

## 0.1.0

- Added the iframe Bridge SDK and typed platform capability wrappers.
- Added CLI commands for initialization, platform binding, diagnostics, build,
  validation, packaging, upload, and review submission.
- Added the React Todo example and the application market specification.
- Made public application identifiers platform-generated.
- Added manifest API-scope and category validation, build-gated release packaging,
  idempotent version publishing, and `doctor` readiness checks.
- Hardened bundles against secrets and symbolic-link escapes; SDK bridge failures
  now expose stable `AppSdkError` codes and validate target origins/timeouts.
