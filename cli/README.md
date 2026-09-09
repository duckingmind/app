# @codex/proxy-app-cli

CLI for developing, validating, packaging, and publishing applications for the
Proxy App platform.

## Install

The CLI requires Node.js 20.19 or newer. Install it from npm after the package
is published:

```bash
npm install --global @codex/proxy-app-cli
```

When working in this repository, run it from the repository root instead:

```bash
npm run app -- --help
```

## Commands

`<app-dir>` is the directory containing `manifest.json` and the app's build
script.

```bash
# Create a starter app and connect it to a platform app
proxy-app init apps/my-app --name "My App"
proxy-app create apps/my-app

# Link an existing local app to a platform app by its platform ID
proxy-app link apps/my-app <app-id>

# Run the app's own build script and validate the resulting dist/ directory
proxy-app build apps/my-app
proxy-app validate apps/my-app
proxy-app doctor apps/my-app

# Package the built app (manifest.json is placed at the ZIP root)
proxy-app pack apps/my-app

# Upload a version without submitting it for review
proxy-app upload apps/my-app

# Upload a missing version and submit it for platform review
proxy-app publish apps/my-app

# Inspect the local binding and remote version state
proxy-app status apps/my-app
```

Release `pack`, `upload`, and `publish` require a successful build and use the
`dist/` output. `--source` is available on `pack` and `upload` only for local
debugging; source packages are not release packages. The app manifest version
must be increased for a new artifact. `publish` submits the version for review;
it does not bypass platform review or make an app immediately public.

## Management authentication

Management commands (`create`, `link`, `upload`, `publish`, and authenticated
`status`) use the current platform Portal user's access token. The CLI does not
provide a `login` command and never passes this token to the app runtime.

1. Sign in to the platform Portal as the app owner.
2. In the browser developer tools, open the Portal origin's local storage and
   copy the `access_token` value.
3. Export it only in the shell used for the command:

```bash
export PROXY_API_BASE_URL="https://your-platform.example/api"
printf 'Portal access token: '
read -rs PROXY_USER_ACCESS_TOKEN
export PROXY_USER_ACCESS_TOKEN
printf '\n'

proxy-app create apps/my-app
proxy-app build apps/my-app
proxy-app upload apps/my-app
proxy-app publish apps/my-app

unset PROXY_USER_ACCESS_TOKEN
```

For a local platform, the default API base is
`http://localhost:9003/api`. `PROXY_ACCESS_TOKEN` is accepted as a legacy alias
for `PROXY_USER_ACCESS_TOKEN`. Never commit either variable, browser cookies,
App Session tokens, or provider credentials.

## Local development

```bash
proxy-app dev apps/my-app --port 5173
```

Development uses a loopback Relay and the signed-in user's short-lived App
Session. The default runtime requests use HTTP. Pass `--legacy-bridge` only when
running an app that explicitly needs the v1 Bridge compatibility path. The
management token is not injected into the app process.

See the repository documentation for the manifest, runtime API, and release
contract:

- [`docs/APP_MARKET.md`](../docs/APP_MARKET.md)
- [`docs/API_REFERENCE.md`](../docs/API_REFERENCE.md)
- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
