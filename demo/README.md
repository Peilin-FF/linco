# Play with Linco

The public playground is ready to build; GitHub Pages still needs to be enabled
by a repository administrator before a public link can go live.

## Run it now

```sh
git clone https://github.com/Peilin-FF/linco.git
cd linco
npm ci
npm run demo:dev
```

Open **http://127.0.0.1:1432/**. No desktop backend, model account or SSH server is required.

Grow the Pocket Garden, try **Add a sunflower** and **Make it midnight**, edit
`src/garden.json` in Code, or explore sample projects, logs and the theme gallery.
Agent replies are scripted; no AI model or command is executed. Don't enter
credentials. Demo file changes are in memory only and reset on reload.

## Publish the public playground

1. In [repository Pages settings](https://github.com/Peilin-FF/linco/settings/pages),
   choose **GitHub Actions** as the source.
2. Run the **Product demo** workflow from GitHub Actions.
3. Verify `https://peilin-ff.github.io/linco/` and replace the README's links to
   this instruction page with that live URL.

Build locally with `npm run demo:build`; output goes to
`node_modules/.cache/linco-site`, outside the desktop bundle.

## Boundaries

- The public build reuses the real desktop React interface and shared synthetic
  workspace fixtures. It never uses the Rust backend.
- The native preview boundary is replaced by a small interactive sample project.
- Account setup sections are hidden; SSH and network Git actions are rejected.
- No analytics, model requests or real Notion connections are added.
- Browser checks: `npx playwright test --config demo/playwright.config.ts`.
