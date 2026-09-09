# App API Reference

This reference describes the public APIs available to a published application. Use the SDK
instead of calling platform endpoints directly; the SDK keeps request paths, authentication,
response decoding, and streaming behavior consistent across local development and production.

## Create a client

```ts
import { createAppClient } from '@ducking-mind/proxy-app-sdk'

const app = createAppClient('app.example')
```

The application identifier is supplied by the platform when the application is created. Keep it
in the application bundle as configuration; never put a user password, provider key, or publishing
credential in the bundle.

## User and platform services

```ts
const profile = await app.user.getProfile()
const capabilities = await app.platform.capabilities()

await app.storage.set('draft', { title: 'Example' })
const draft = await app.storage.get<{ title: string }>('draft')
await app.storage.delete('draft')
```

Storage is scoped to the application and the signed-in user. Use small JSON values and stable keys.
The platform may reject values that exceed its published size limits. Treat a missing value as
`null` and handle permission or sign-in errors in the UI.

Applications can read the signed-in user's basic profile when the manifest requests the matching
permission. Profile fields are platform-defined and may be omitted for privacy reasons.

## Model and media requests

`app.api.request` accepts the platform's relative API paths and returns JSON, text, binary data, or
the native `Response` according to `responseType`.

```ts
const models = await app.api.request('/models')

const result = await app.api.request('/responses', {
  method: 'POST',
  body: JSON.stringify({
    model: 'model-id-from-platform',
    input: 'Write a short welcome message.',
  }),
})

const video = await app.api.request<Blob>('/videos/task-id/content', {
  responseType: 'blob',
})
```

Supported request families include model discovery, text and message generation, embeddings,
image generation and editing, video tasks, and music tasks. The exact model list and available
operations depend on the user's account, the application permissions, and platform review.
Applications do not choose an upstream provider or submit provider credentials.

### Streaming

Use `stream` for server-sent events:

```ts
for await (const event of app.api.stream('/responses/stream', {
  method: 'POST',
  body: JSON.stringify({ model: 'model-id', input: 'Stream this answer.' }),
})) {
  if (event.data) console.log(event.data)
}
```

The SDK parses event frames and exposes each frame as `{ event?, data }`. Stop consuming when the
server sends its terminal event and provide a cancellation control for long-running requests.

## Sessions and errors

The platform supplies a short-lived application session after the user signs in or opens an
installed application. The SDK stores session state in memory and attaches it to approved requests.
Applications must not persist the session or attempt to construct one themselves.

Catch `AppSdkError` and use its stable `code`, optional HTTP `status`, `requestId`, and `details` to
show a useful message and offer a retry where appropriate:

```ts
import { AppSdkError } from '@ducking-mind/proxy-app-sdk'

try {
  await app.api.request('/models')
} catch (error) {
  if (error instanceof AppSdkError && error.code === 'APP_LOGIN_REQUIRED') {
    await app.auth.login()
  }
}
```

`app.auth.login()` and `app.auth.logout()` are available for local development. In a published
application, sign-in is handled by the platform page that opens the application. A user may close
the page or lose network access at any time, so loading, retry, timeout, and sign-out states should
be part of the UI.

## Local development

Install the CLI and start the application through it:

```bash
npm install --global @ducking-mind/proxy-app-cli
proxy-app dev apps/my-app
```

The CLI configures a local HTTP proxy for the platform paths and opens the platform sign-in flow
when a request needs a user session. Use the Vite helper in `vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import { createPlatformDevProxy } from '@ducking-mind/proxy-app-sdk/vite'

export default defineConfig({
  base: './',
  server: {
    proxy: createPlatformDevProxy(),
  },
})
```

The proxy is a development convenience. It is not part of the release bundle and does not replace
the platform's published application runtime.

## Security and compatibility

Use only SDK APIs documented for applications. Do not read browser storage belonging to the
platform, call management endpoints, embed private URLs, or put account credentials in source
control. Keep dependencies current and validate the manifest before every release.

The SDK retains compatibility with older embedded applications. New applications should use the
HTTP client and relative SDK paths so the same code works during development and after publication.
