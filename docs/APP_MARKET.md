# Publishing an App

This guide covers the public application package format and the review workflow. The platform
hosts the built files, signs in users, and provides approved runtime services. An application is a
frontend package; it should not contain platform credentials or a private service endpoint.

## Package workflow

```text
proxy-app init
  -> develop with proxy-app dev
  -> build and validate
  -> pack and upload a version
  -> submit for review
  -> publish after approval
```

Each uploaded version is immutable. Increase `manifest.version` for a new build. A rejected version
can be fixed and uploaded again; the currently published version remains available until a new
version is approved.

## Manifest

The manifest is stored at the root of the application source and is included at the root of the
release archive:

```json
{
  "schema": "proxy.app/v1",
  "id": "app.example",
  "version": "1.0.0",
  "name": "Example App",
  "description": "A concise description for the app market.",
  "runtime": { "type": "iframe", "entry": "index.html" },
  "permissions": ["storage.user"],
  "apis": ["model.responses"],
  "backend": { "type": "platform" },
  "pricing": { "mode": "free", "currency": "CNY" }
}
```

Required fields are `schema`, `id`, `version`, `name`, `runtime.type`, and `runtime.entry`.
The platform assigns the permanent application identifier when the application is created; use the
identifier written by the CLI rather than inventing a production identifier.

Optional declarations:

| Field | Values | Purpose |
| --- | --- | --- |
| `permissions` | `user.profile.read`, `storage.user`, `notification`, `theme.read`, `locale.read` | Request the smallest set of user or platform services needed by the app. |
| `apis` | `model.responses`, `model.chat`, `model.messages`, `model.embeddings`, `model.images`, `model.videos`, `model.music` | Declare the model or media families used by the app. |
| `pricing.mode` | `free`, `one_time`, `commission` | Select the commercial model offered during review. |

Permissions and API declarations are requests, not a way to bypass user consent or platform review.
Ask only for capabilities visible in the app and explain them in the listing.

## Release commands

```bash
proxy-app build apps/my-app
proxy-app validate apps/my-app
proxy-app pack apps/my-app /tmp/my-app.zip
proxy-app upload apps/my-app
proxy-app publish apps/my-app
```

`build` creates the release files, `validate` checks the manifest and output, and `pack` creates an
archive suitable for inspection or upload. `upload` creates a draft version. `publish` submits that
version for platform review; it does not skip review or make the listing public immediately.

Use the platform's official sign-in or CI secret configuration for management commands. Keep
publishing credentials outside the source tree and never expose them to application JavaScript.

## Review checklist

Before submitting a version:

- The app starts from the declared entry file and works on a fresh install.
- The listing name, description, screenshots, and requested permissions match the actual behavior.
- External assets, fonts, code, and model prompts have licenses that allow redistribution.
- User data is minimized, clearly described, and deleted when the user requests deletion.
- Network failures, unavailable capabilities, empty results, and long-running tasks have visible UI states.
- The release archive contains only the built app and public metadata; it contains no credentials,
  development environment files, debug dumps, or unrelated source material.

After approval, the platform makes the approved version available to users. Existing installations
continue using their selected version until the platform's update rules or the user changes it.
