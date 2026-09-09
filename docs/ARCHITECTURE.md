# Proxy App Framework Architecture

Status (2026-09-08): the standalone HTTP target is specified in
[HTTP_RUNTIME_DESIGN.md](HTTP_RUNTIME_DESIGN.md). Published v1 apps currently
still use AppHost/iframe, while local SDK/CLI default to HTTP model and
application resources. `direct` needs an injected v2 App Session and refresh
callback; page-runtime v2 is the migration target. App authorization-code/PKCE
endpoints are not implemented yet. See API_REFERENCE.md for the implemented subset.

## Product Model

Proxy App is a frontend package that runs with the current platform user's
identity. The app does not own a provider, API key, backend credential, or
independent billing account.

The app owner relationship is used only for creating, uploading, submitting,
and managing versions. Runtime model and media calls are always made for the
user who opened or installed the app. The user receives the platform quota and
billing result.

## Layered Architecture

```text
Standalone app (target, not implemented end to end)
  -> platform OAuth + PKCE
  -> user App Session (ast_*)
  -> llm-gateway /v1

Local source (compatibility runtime)
  -> proxy-app dev
  -> Vite + SDK proxy
  -> loopback Relay
  -> Portal login token handoff to Relay (current; to be replaced)
  -> user App Session (ast_*)
  -> llm-gateway /v1
  -> models, media, routing, quota and billing

Published ZIP
  -> AppHost iframe
  -> host handshake
  -> user App Session (ast_*)
  -> llm-gateway /v1
```

| Module | Responsibility | Must not do |
| --- | --- | --- |
| `cli` | Project lifecycle, local development, build, package, upload and review submission | Implement model routing or expose Portal tokens to the app |
| `proxy-app-sdk` | App runtime API, Bridge, App Session and Vite adapter | Call Portal management, internal service or provider APIs |
| Local Relay | Current login handoff, loopback registration, App Session creation/refresh and local forwarding; PKCE is planned | Become an app backend or persist user credentials |
| `portal` | Login, market UI and host UI | Inject Portal cookies/JWT into the iframe |
| `admin-api-go` | App ownership, versions, review, installation, Bridge and Session issuance | Handle high-throughput model execution |
| `llm-gateway-go` | `/v1` data plane, model/media execution, routing, quota, charging and task state | Own app publishing or app UI |
| `shared` | Shared contracts and models | Contain service-specific orchestration |

## Two API Planes

### Control plane

Used by the platform UI and CLI for `create`, `link`, `upload`, `publish`,
installation, review and App Session issuance. The CLI management token is only
for these operations and is never passed to the app process.

### Runtime data plane

Used by the SDK through allow-listed `/v1` routes. It receives a short-lived
`ast_*` App Session bound to user, app, installation, version and scopes. The
same data plane handles text, image, video and audio requests. The platform
decides provider routing, pricing, quota and settlement.

## Lifecycle

```text
init -> create/link -> proxy-app dev -> platform login -> real API test
     -> build -> validate/doctor -> pack -> upload draft
     -> test version -> submit review -> approval -> market AppHost
```

Standalone model calls and published execution share the same platform data
plane and can call Gateway with an existing user App Session. Current published
v1 apps still require AppHost for session bootstrap and Bridge capabilities;
HTTP storage/profile are implemented; standalone login is not complete. Page
runtime v2 replaces these dependencies with explicit HTTP contracts and keeps a
local development proxy for origin and authentication adaptation.
The supported local integration path does not use mock APIs.

## Manifest Boundary

`manifest.json` declares package identity, presentation, runtime entry, public
Bridge permissions, data-plane API families, and app commercial metadata. It
must not declare providers, endpoints, supplier prices, upstream keys, routing
weights, or user quotas.

## Security Rules

- Do not add `app_sk_*` or another app-owned runtime key.
- Do not put Portal tokens, cookies, API keys or COS secrets in an app bundle.
- Do not expose Portal management APIs, internal service addresses or provider
  APIs to application code. The planned App Runtime HTTP routes may be served
  by Admin API, with separate AppSession authentication and narrow scopes.
- Use `proxy-app dev` for real platform debugging; direct Vite is UI-only.
- Keep routing, billing and provider capability logic in platform services.

## Directory Rules

```text
app/
├── cli/                  # CLI and local Relay
├── proxy-app-sdk/        # Runtime SDK and Vite adapter
├── apps/                 # Reference apps only; private npm workspaces
├── docs/                 # Public contracts and architecture
├── dist/                 # Generated local artifacts
└── releases/             # Sample release artifacts
```

New runtime features belong in the SDK and platform contracts first. Example
apps should demonstrate workflows and must not become a second platform
implementation.
