# Monkeytiles Development Guide

This guide covers setting up, running, testing, and contributing to Monkeytiles locally.

## Prerequisites

Install the following before getting started:

* Git
* Node.js (includes npm)
* A code editor such as Visual Studio Code
* MongoDB (only for testing persistent-room functionality)

Verify your installation:

```bash
git --version
node --version
npm --version
```

## Repository setup

Fork the repository on GitHub, then clone your fork:

```bash
git clone https://github.com/<your-username>/monkeytiles.git
cd monkeytiles
```

Your fork is added as `origin`. Add the original repository as `upstream`:

```bash
git remote add upstream https://github.com/nit-sorus/monkeytiles.git
git fetch upstream
git remote -v
```

| Remote     | Purpose                 |
| ---------- | ----------------------- |
| `origin`   | Your fork               |
| `upstream` | The original repository |

To check whether your local `main` is up to date:

```bash
git rev-list --left-right --count main...upstream/main
```

An output of `0 0` means both branches contain the same commits.

## Install dependencies

Install the project's recorded dependencies:

```bash
npm ci
```

Use `npm install` only when intentionally adding or updating dependencies. Avoid running `npm audit fix` without reviewing the proposed changes.

## Environment configuration

Create a local environment file:

```bash
cp .env.example .env
```

Supported environment variables:

| Variable      | Required | Purpose                                           |
| ------------- | -------- | ------------------------------------------------- |
| `PORT`        | No       | Backend port (defaults to `3001`)                 |
| `MONGODB_URI` | No       | MongoDB connection for permanent rooms and scores |
| `NODE_ENV`    | No       | Runtime environment                               |

Never commit `.env` or database credentials.

The server reads configuration from `process.env` but does not automatically
load `.env`. In a macOS or Linux shell, export the file before starting it:

```bash
set -a
source .env
set +a
```

## Run the project

Start both the frontend and backend:

```bash
npm run dev
```

Or run them separately:

```bash
npm run client
npm run server
```

Running them in separate terminals is useful when debugging client and server logs independently.

## Available commands

| Command               | Purpose                                     |
| --------------------- | ------------------------------------------- |
| `npm run client`      | Start the Vite development server           |
| `npm run server`      | Start the Node.js and Socket.IO server      |
| `npm run dev`         | Start frontend and backend together         |
| `npm run lint`        | Run Oxlint                                  |
| `npm run build`       | Build the production frontend into `dist/`  |
| `npm run preview`     | Preview the production build locally        |
| `npm run deploy`      | Build and publish `dist/` with GitHub Pages |
| `npm test`            | Run production server integration tests    |
| `npm run test:legacy` | Run the existing mock state-machine test    |

## Verification baseline

Before making changes, run:

```bash
npm run lint
npm run build
npm test
npm run test:legacy
npm audit --omit=dev
git status -sb
```

Baseline results before the refactoring effort:

* Build completed successfully.
* The production integration test and legacy mock test passed.
* Lint reported three warnings and no errors.
* The working tree remained clean after installation and build.
* `npm audit --omit=dev` reported `concurrently` through `shell-quote`.

Current lint warnings:

1. Unused `BookOpen` import in `src/App.jsx`.
2. Unused `e` catch parameter in `src/App.jsx`.
3. Missing React effect dependencies for `socket` and `sessionToken`.

These warnings are part of the current baseline and should not automatically be treated as regressions.

## Test coverage

`npm test` imports the production `server.js`, starts it on an available port,
and connects two Socket.IO clients. It verifies room creation, joining, game
startup, and synchronized card flips.

`npm run test:legacy` runs `server_test.js`, which uses a simplified mock
Socket.IO server. TODO tests record missing coverage for hidden card data,
host-only controls, and duplicate-player identity handling. Reconnection,
complete scoring, and MongoDB persistence also need additional coverage.

## Branch workflow

Create changes on a feature branch instead of working directly on `main`:

```bash
git switch main
git fetch upstream
git merge --ff-only upstream/main
git push origin main
git switch -c <category>/<short-description>
```

Common branch prefixes:

* `docs/`
* `test/`
* `fix/`
* `feat/`
* `refactor/`
* `foundation/`

## Review before committing

Inspect your changes:

```bash
git status -sb
git diff
```

Stage only the files you intend to commit:

```bash
git add README.md docs/ .env.example
```

Review the staged changes:

```bash
git diff --staged
```

Create a focused commit:

```bash
git commit -m "docs: document architecture and development setup"
```

## Pull request checklist

Before opening a pull request:

* review the complete diff;
* run lint, build, and relevant tests;
* update documentation if needed;
* verify no credentials or `.env` files are staged;
* explain what changed, why, and how it was verified.

## Sync with upstream

Fetch the latest changes:

```bash
git fetch upstream
```

Update your local `main`:

```bash
git switch main
git merge --ff-only upstream/main
git push origin main
```

Return to your feature branch and rebase if appropriate:

```bash
git switch <feature-branch>
git rebase main
```

Avoid rebasing shared branches unless everyone involved has agreed.

## Generated and local files

The following should not be committed:

* `node_modules/`
* `dist/`
* `.env`
* log and cache files

These paths are already excluded by `.gitignore`.
