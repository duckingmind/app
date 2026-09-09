# Todo Demo

Todo Demo is a minimal React and Vite starter for a Proxy App. It shows how to
create an SDK client, read the current user's profile, and save a small piece
of user-scoped state. Use it as a starting point for a new app.

The app uses `base: './'`, so built assets work from the platform's versioned
asset URL. Its manifest is packaged at the root of the release ZIP.

## Run locally

From this repository's `app` directory:

```bash
npm install
npm run sdk:build
npm run app -- dev apps/todo
```

For UI-only work, run the app's Vite script directly:

```bash
npm --workspace proxy-todo-app run dev
```

The platform development command provides the runtime needed for SDK calls.

## Validate, build, and package

```bash
npm run app -- validate apps/todo
npm run app -- build apps/todo
npm run app -- pack apps/todo dist/todo.zip
```

The same commands can be used with another app directory. To scaffold a new
project, run:

```bash
npm run app -- init apps/my-app --name "My App"
```

Update the generated manifest with your app name, identifier, permissions, and
API capabilities. Upload the resulting ZIP through the developer console,
test the version in the host, and publish it when ready.
