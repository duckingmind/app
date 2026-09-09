# Proxy App Platform

Open-source tools for building, testing, and publishing applications on the
Proxy platform. This repository includes:

- `proxy-app-sdk`: the TypeScript SDK for platform applications.
- `cli/proxy-app.mjs`: the `proxy-app` command-line tool.
- `apps/*`: runnable example applications.
- `docs/*`: the application manifest, API, and publishing reference.

The source is MIT licensed. See [NOTICE.md](NOTICE.md) for the separate
provenance and redistribution terms for demonstration images.

## Requirements

- Node.js 22.12 or newer
- npm
- An account and application on a compatible Proxy platform deployment for
  authenticated development and publishing

## Quick start

Clone the repository and install its workspaces:

```bash
git clone https://github.com/duckingmind/app.git
cd app
npm ci
npm run sdk:build
npm run example:build
npm run example:validate
```

The build and validation commands run without platform credentials. The CLI
reads configuration from exported shell variables; it does not load `.env`
files automatically. Keep credentials in your shell or CI secret store.

To install the published CLI globally instead of running the workspace copy:

```bash
npm install --global @ducking-mind/proxy-app-cli
```

## Create and run an app

Initialize an app directory, connect it to a platform application, and start
development:

```bash
npm run app -- init apps/my-app --name "My App"
npm run app -- create apps/my-app
npm run app -- dev apps/my-app --port 5173
```

`init` creates a starter project and manifest. Use `link` instead of `create`
when the app already exists on the platform. The app directory must contain a
`manifest.json` and a build script.

## Platform authentication

Commands that create, link, inspect, upload, or publish an app require a
platform user access token. Set the platform API endpoint and token in the
shell used to run the command, following your platform's documented
authentication flow:

```bash
export PROXY_API_BASE_URL="https://platform.example/api"
export PROXY_USER_ACCESS_TOKEN="<platform-user-token>"

npm run app -- create apps/my-app
npm run app -- status apps/my-app
```

Do not commit access tokens, cookies, provider credentials, or local binding
files. `PROXY_USER_ACCESS_TOKEN` is used for app management and is not passed
to the app runtime. CI jobs should provide it through their secret manager.

## Build and publish

Run the checks locally before creating a release artifact:

```bash
npm run app -- build apps/my-app
npm run app -- validate apps/my-app
npm run app -- doctor apps/my-app
npm run app -- pack apps/my-app
```

Upload a built version for testing, or upload and submit it for platform
review:

```bash
npm run app -- upload apps/my-app
npm run app -- publish apps/my-app
```

`pack`, `upload`, and `publish` use the `dist/` directory produced by the app
build. Increase `manifest.json`'s version for each new release. `publish`
submits the version for review; it does not bypass the platform review
process. Use `status` to inspect the local binding and remote version state.

See [cli/README.md](cli/README.md) for the complete command reference.

## Repository layout

```text
app/
├── cli/                  # proxy-app CLI
├── proxy-app-sdk/        # TypeScript SDK
├── apps/                 # example applications
└── docs/                 # platform development documentation
```

Useful references:

- [Application market guide](docs/APP_MARKET.md)
- [API reference](docs/API_REFERENCE.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
