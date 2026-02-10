# README — Build & Package Azure DevOps AI Code Reviewer (VSIX)

This repository is a **monorepo** containing a reusable core engine and an Azure DevOps (ADO) Pipeline task packaged as a VSIX extension.

The Azure DevOps task **does not install npm dependencies at runtime**, so the task must be **fully self-contained at packaging time**.

This project solves that by:

* **Bundling task code with esbuild**
* **Externalizing only required runtime libraries**
* **Installing runtime dependencies into the task payload**
* **Generating a clean VSIX layout automatically**

No manual copying. No guessing which `node_modules` to ship.

---

## Architecture Overview

```
devops-ai-reviewer/
├── packages/
│   ├── core/              # Review engine (@devops-ai-reviewer/core)
│   └── ado-task/          # Azure DevOps task implementation
│       ├── src/           # TypeScript sources
│       ├── task.json      # ADO task definition
│       └── build/
│           └── package-extension.mjs  # 🔑 main packaging script
│
├── extensions/
│   └── azure-devops/
│       ├── vss-extension.json
│       └── assets/
│
└── out/
    └── azure-devops-extension/  # ✅ final VSIX payload (generated)
```

Azure DevOps runs the task from:

```
out/azure-devops-extension/tasks/ADOCodeReview/dist/main.js
```

---

## Prerequisites

* Node.js **18+** (Node 20 recommended)
* npm
* Azure DevOps `tfx-cli` (only for packaging/publishing)

Install `tfx` once:

```bash
npm install -g tfx-cli
```

---

## How Packaging Works (Important)

### Key principles

* **esbuild bundles all application code** (including `@devops-ai-reviewer/core`)
* **Dynamic / native modules are externalized**, notably:

  * `azure-pipelines-task-lib`
  * `shelljs`
  * `glob`
* A **minimal `package.json`** is generated inside the task payload
* Runtime dependencies are installed **once** into the task folder
* The VSIX layout is produced under `out/azure-devops-extension`

This avoids:

* copying random folders from root `node_modules`
* missing dynamic `require()` files (e.g. `./src/cat`)
* Azure DevOps runtime crashes

---

## 1) Install dependencies (monorepo root)

From the repo root:

```bash
npm ci
```

This installs all workspace dependencies and tools (including esbuild).

---

## 2) Build & package the Azure DevOps extension

This **single command** does everything:

```bash
npm -w @devops-ai-reviewer/ado-task run package:extension
```

What this does internally:

1. Bundles the task with esbuild
2. Creates `out/azure-devops-extension/`
3. Copies:

   * `task.json`
   * bundled `dist/main.js`
   * runtime `node_modules`
   * `vss-extension.json`
   * extension assets
4. Produces a ready-to-package VSIX layout

---

## 3) Verify the generated layout (sanity check)

After packaging, you should have:

```
out/azure-devops-extension/
├── vss-extension.json
├── assets/
└── tasks/
    └── ADOCodeReview/
        ├── task.json
        ├── dist/
        │   └── main.js
        └── node_modules/
            ├── azure-pipelines-task-lib/
            ├── shelljs/
            └── glob/
```

Optional verification (Windows PowerShell):

```powershell
  Test-Path out\azure-devops-extension\tasks\ADOCodeReview\dist\main.js
  Test-Path out\azure-devops-extension\tasks\ADOCodeReview\node_modules\azure-pipelines-task-lib\task.js
```

Both should return `True`.

---

## 4) Local runtime sanity check (optional)

This verifies **Node module resolution**, not ADO environment variables.

```bash
node out/azure-devops-extension/tasks/ADOCodeReview/dist/main.js
```

If this fails, packaging is incorrect and **ADO will fail too**.

---

## 5) Create the VSIX package

```bash
cd out/azure-devops-extension
tfx extension create --manifest-globs vss-extension.json
```

This produces:

```
ADOCodeReview-<version>.vsix
```

---

## 6) Publish or share the extension

### Login (once)

```bash
tfx login \
  --service-url https://marketplace.visualstudio.com \
  --auth-type pat \
  --token YOUR_PAT
```

### Publish (private or public)

```bash
tfx extension publish --manifest-globs vss-extension.json
```

Or share privately to an organization:

```bash
tfx extension share \
  --manifest-globs vss-extension.json \
  --share-with YOUR_ORG
```

---

## 7) Using the task in a pipeline

Example PR validation step:

```yaml
- task: ADOCodeReview@1
  inputs:
    api_key: '$(OPENAI_API_KEY)'
    ai_model: 'gpt-4o'
    bugs: true
    performance: true
    best_practices: true
    verbose_logging: true
```

⚠️ **Always store API keys as secret variables** — never commit them.

---

## Common pitfalls (and why this setup avoids them)

### ❌ “Cannot find module './src/cat'”

Cause: bundling `azure-pipelines-task-lib` or `shelljs`

✅ Fixed by externalizing and shipping runtime deps.

---

### ❌ “node_modules missing in Azure DevOps”

Cause: assuming ADO installs dependencies

✅ Fixed by installing runtime deps into the task payload.

---

### ❌ Manual copying mistakes

Cause: guessing which folders to vendor

✅ Fixed by deterministic packaging script.

---

## Notes / Future improvements

* This setup is **production-safe**
* VSIX size is reasonable and predictable
* Next steps could include:

  * tree-shaking LLM providers
  * optional ESM build
  * caching PR comments for deduplication
  * Marketplace public release