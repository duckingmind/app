# @ducking-mind/proxy-app-cli

`proxy-app` is the command-line tool for creating, developing, validating,
packaging, and publishing Proxy platform applications.

## Install

The CLI requires Node.js 22.12 or newer. Install the published package with
npm:

```bash
npm install --global @ducking-mind/proxy-app-cli
```

When working in this repository, run the workspace version from the repository
root:

```bash
npm run app -- --help
```

## Commands

`<app-dir>` is the directory containing `manifest.json` and the app's build
script.

```bash
# Create a starter app
proxy-app init apps/my-app --name "My App"

# Create or connect the platform application
proxy-app create apps/my-app
proxy-app link apps/my-app <app-id>

# Develop, build, and validate
proxy-app dev apps/my-app --port 5173
proxy-app build apps/my-app
proxy-app validate apps/my-app
proxy-app doctor apps/my-app

# Package and release
proxy-app pack apps/my-app
proxy-app upload apps/my-app
proxy-app publish apps/my-app

# Inspect the local binding and remote version state
proxy-app status apps/my-app
```

`init` creates the local manifest and starter files. Use `create` for a new
platform application or `link` for an existing one. `dev` runs the app's local
development workflow. `doctor` reports configuration and release-readiness
problems.

Release commands use the `dist/` output from a successful build. The app
manifest version must increase for each new release. `pack` creates an archive,
`upload` sends a version to the platform without submitting it for review, and
`publish` uploads when needed and submits the version for review. Use
`--source` with `pack` or `upload` only for local debugging; source packages
are not release packages.

## Platform authentication

Management commands (`create`, `link`, authenticated `status`, `upload`, and
`publish`) require a platform user access token. Obtain a token through your
platform's documented authentication flow and provide it in the shell or CI
environment:

```bash
export PROXY_API_BASE_URL="https://platform.example/api"
export PROXY_USER_ACCESS_TOKEN="<platform-user-token>"

proxy-app create apps/my-app
proxy-app upload apps/my-app
proxy-app publish apps/my-app
```

The CLI reads exported variables and does not load `.env` files automatically.
Keep tokens, cookies, provider credentials, and generated local binding files
out of source control. The management token is used by the CLI and is not
passed to the app runtime.

## Configuration

Set `PROXY_API_BASE_URL` to the API endpoint for the platform deployment you
are using. Set `PROXY_USER_ACCESS_TOKEN` for commands that modify or inspect a
platform application. The platform may provide additional configuration for
local development; follow its documentation for those settings.

See the repository documentation for the manifest, runtime API, and release
contract:

- [`docs/APP_MARKET.md`](../docs/APP_MARKET.md)
- [`docs/API_REFERENCE.md`](../docs/API_REFERENCE.md)
