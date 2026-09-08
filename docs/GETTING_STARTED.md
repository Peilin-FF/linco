# Getting started with Linco

## Desktop: from an idea to a working project

1. Download a platform installer from [Releases](https://github.com/Peilin-FF/linco/releases/latest).
2. Install and authorize the coding CLI you want to use. Linco launches configured agents; it does not provide model credits.
3. Open a local project. For a remote workspace, configure an SSH host and ensure the tools you need are installed on that host.
4. Select an agent and start in **Vibe Working**. Use the live preview for supported project output; switch to **Code** to inspect files, Git and terminals.
5. Review generated changes and run relevant checks. Agent output is not verification by itself.

The current Mac installers are ad-hoc signed, not Apple-notarized. A first-launch security warning may appear. Check the download's source before deciding whether to open it.

## Notes and project memory

Notion features require the native desktop backend and the appropriate connection/authorization. A browser-only preview cannot embed the native Notion editor. Research spaces organize projects, milestones, explorations, literature, runs and conclusions. Briefings use the records you select; they do not automatically recover every past experiment.

## Browser demo

```sh
npm ci
npm run demo:dev
```

Open `http://127.0.0.1:1432`. The **Pocket Garden** example lets you:

- Water plants and see them bloom.
- Submit “Add a sunflower” or “Make it midnight” for a scripted change.
- Edit and save `src/garden.json`, then see the preview update.
- Browse synthetic logs, projects and milestones, and try the built-in themes.

No AI service, real terminal, remote server or Notion account is used. Do not enter secrets into the demo. File and research edits are synthetic; reloading resets the sample data. Browser preferences such as themes may persist locally.

## Build the desktop

Install the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/), Rust and Node.js, then run:

```sh
npm ci
npm run tauri:dev
```

Use `npm run tauri:build` for native bundles. A plain `npm run dev` starts only the frontend and cannot provide native file, terminal, SSH or Notion capabilities.

## Separate iPhone / Linux setup

The iPhone client connects to `linco-server` over HTTPS/WSS, not the desktop SSH connection. Follow [iPhone instructions](../ios/README.md), [server deployment](DEPLOYMENT.md), and [native architecture](native-architecture.md).
