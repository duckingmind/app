# @ducking-mind/proxy-app-sdk

TypeScript SDK for applications running on the Proxy App platform. The SDK
provides one client for embedded apps, local development, and standalone HTTP
integrations.

## Install

```bash
npm install @ducking-mind/proxy-app-sdk
```

The package ships ESM JavaScript and TypeScript declarations. Build the SDK
from source with `npm run build` when working in this repository.

## Create a client

```ts
import { createAppClient, AppSdkError } from '@ducking-mind/proxy-app-sdk'

const app = createAppClient('com.example.my-app')

const profile = await app.user.getProfile()
const models = await app.api.request('/models')

for await (const event of app.api.stream('/responses/stream', {
  method: 'POST',
  body: JSON.stringify({ model: 'your-model', input: 'Hello' }),
})) {
  console.log(event.data)
}
```

The app ID must be a lowercase reverse-domain identifier. In an embedded app,
the host supplies a short-lived App Session during the startup handshake. The
SDK keeps that session in memory and attaches it to approved data-plane
requests.

## Platform APIs

The client exposes these host capabilities:

- `app.user.getProfile()` reads the signed-in user's public profile.
- `app.storage.get/set/delete()` stores user-scoped JSON values.
- `app.notification.show()` asks the host to display a notification.
- `app.theme.read()` and `app.locale.read()` read host preferences.
- `app.platform.capabilities()` lists capabilities granted to the app.
- `app.platform.call()` invokes a capability by its documented method name.

For model and media work, use `app.api.request()` or `app.api.stream()`. Routes
include model catalogs, Responses, chat completions, embeddings, image
generation/editing, and video or music task operations. The platform controls
which routes and capabilities each app may use.

`request()` decodes JSON and text automatically and returns other media as a
`Blob`. Set `responseType` to `json`, `text`, `blob`, `arrayBuffer`, or
`response` when the response format is known. JSON string bodies receive a
default `Content-Type: application/json`; `FormData` and binary bodies are
passed through unchanged.

## Runtime options

Embedded apps need no options:

```ts
const app = createAppClient('com.example.my-app')
```

For a standalone integration, provide an App Session obtained from the
platform's session flow and a refresh callback:

```ts
const app = createAppClient('com.example.my-app', {
  runtime: 'direct',
  appSession,
  refreshAppSession: async () => getFreshAppSession(),
})
```

Use the runtime base path supplied by the platform deployment when a direct
integration requires an explicit value. Application code should otherwise use
the SDK's relative paths and avoid hard-coding private platform routes.

The SDK refreshes and retries only when the platform explicitly reports that
an App Session expired before execution. Other authentication errors are
returned to the caller. Call `app.platform.createSession()` when an
embedded host needs a proactive session refresh.

## Local development

Use the platform CLI to run the development relay, then register its Vite
proxy:

```ts
import { defineConfig } from 'vite'
import { createPlatformDevProxy } from '@ducking-mind/proxy-app-sdk/vite'

export default defineConfig({
  base: './',
  server: { proxy: createPlatformDevProxy() },
})
```

Start the app with:

```bash
proxy-app dev <app-directory>
```

The CLI supplies the relay configuration. A user sign-in may be required on
the first data request; applications can offer `app.auth.login()` from a user
gesture if the automatic sign-in window is blocked. `app.auth.logout()` clears
the local development session. Do not enable local-development options in a
release build.

## Errors

Failures are thrown as `AppSdkError` with a stable `code`, optional HTTP
`status`, `requestId`, and structured `details`. Handle session and bridge
errors explicitly so the UI can offer retry or reconnect actions:

```ts
try {
  await app.api.request('/models')
} catch (error) {
  if (error instanceof AppSdkError) {
    console.error(error.code, error.requestId, error.details)
  }
}
```

The SDK never exposes platform management credentials to an app. Keep app
sessions short-lived and in memory, and request only the capabilities declared
by the app manifest.

## Build and publish

From the platform project root, validate and package an app with the CLI:

```bash
npm install
npm run app -- build apps/my-app
npm run app -- validate apps/my-app
npm run app -- pack apps/my-app dist/my-app.zip
```

Upload the ZIP through the developer console, test the version in the host,
and publish it when ready. See the platform documentation for manifest
format, permissions, API availability, and review requirements.
