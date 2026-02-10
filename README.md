# Azure DevOps PR Code Reviewer (ADOCodeReview)

**ADOCodeReview** is a modular AI-powered code review system designed to analyze Pull Requests using OpenAI or Azure OpenAI.
It can be used as:

* 🧠 **Core library** (framework-agnostic)
* 🌐 **HTTP API** (Postman / integrations)
* 🖥️ **CLI tool** (local & CI usage)
* 🔁 **Azure DevOps Pull Request task** (inline PR comments)

The architecture is intentionally layered so each part can evolve independently.

---

## Architecture Overview

```
devops-ai-reviewer/
├── packages/
│   ├── core        # Review engine (provider-agnostic)
│   ├── api         # HTTP API (Express)
│   ├── cli         # Command-line tool
│   └── ado-task    # Azure DevOps PR task
```

**Core is the single source of truth.**
API, CLI, and Azure DevOps adapters all delegate review logic to the core engine.

---

## 1️⃣ Core (`@devops-ai-reviewer/core`)

### Purpose

The **core package** contains the entire review engine:

* Diff analysis orchestration
* LLM prompt construction
* Confidence filtering
* Deduplication
* Normalized findings output

It has **no dependency on Git, Azure DevOps, or HTTP**.

### Key Concepts

* **ReviewInput** – provider-agnostic review request
* **ReviewPolicy** – controls what the reviewer checks
* **LlmClient** – abstraction over OpenAI / Azure OpenAI
* **ReviewReport** – normalized output used by all adapters

### Example (direct usage)

```ts
import { reviewCode } from '@devops-ai-reviewer/core';

const report = await reviewCode(reviewInput, llmClient);
```

### Why Core Exists

* Testable without CI or cloud
* Reusable across tools
* Safe refactoring and long-term maintainability

---

## 2️⃣ API (`@devops-ai-reviewer/api`)

### Purpose

The API exposes the core engine over HTTP for:

* Postman testing
* Internal tooling
* Non-Git integrations
* Future UI or webhook-based workflows

### Start the API

```bash
cd packages/api
npm install
npm run dev
```

### Environment Variables

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
# OR (Azure)
AZURE_OPENAI_ENDPOINT=https://xxx.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=my-deployment
AZURE_OPENAI_API_VERSION=2024-10-21
```

### Endpoint

`POST /review`

### Example Payload

```json
{
  "target": {
    "provider": "api",
    "repository": { "name": "demo-repo" }
  },
  "files": [
    {
      "path": "/src/auth.ts",
      "diff": "--- a/src/auth.ts\n+++ b/src/auth.ts\n..."
    }
  ],
  "policy": {
    "checks": {
      "bugs": true,
      "performance": true,
      "bestPractices": true
    },
    "modifiedLinesOnly": true,
    "confidence": {
      "enabled": true,
      "minimum": 0.9
    },
    "dedupeAcrossFiles": {
      "enabled": false,
      "threshold": 0.85
    },
    "prompts": {
      "additional": []
    }
  }
}
```

### Response

```json
{
  "summaryMarkdown": "Findings: 2 (0 filtered out, total generated 2).",
  "findings": [ ... ],
  "filteredOut": []
}
```

---

## 3️⃣ CLI (`@devops-ai-reviewer/cli`)

### Purpose

The CLI allows running PR reviews:

* Locally
* In any CI system
* Without Azure DevOps

It works directly against Git diffs and calls the core engine.

### Install (local dev)

```bash
cd packages/cli
npm install
npm link
```

### Run against Git commits

```bash
review-cli \
  --base origin/main \
  --head HEAD \
  --format markdown \
  --fail-on high
```

### Options

| Flag               | Description                 |        |      |           |
| ------------------ | --------------------------- | ------ | ---- | --------- |
| `--base`           | Base commit or branch       |        |      |           |
| `--head`           | Head commit                 |        |      |           |
| `--format`         | `markdown` or `json`        |        |      |           |
| `--fail-on`        | `low                        | medium | high | critical` |
| `--include`        | Glob patterns to include    |        |      |           |
| `--exclude`        | Glob patterns to exclude    |        |      |           |
| `--ext`            | Allowed extensions          |        |      |           |
| `--confidence-min` | Confidence threshold (0..1) |        |      |           |

### Exit Codes

* `0` → no blocking findings
* `1` → at least one finding meets `--fail-on` threshold

---

## 4️⃣ Azure DevOps Task (`@devops-ai-reviewer/ado-task`)

### Purpose

Runs ADOCodeReview automatically on **Azure DevOps Pull Requests** and posts results back as PR comments.

### How It Works

1. Triggered on PR builds
2. Detects new PR iterations
3. Collects changed files + diffs
4. Calls core engine
5. Publishes:

   * A **summary PR comment**
   * (Optionally) inline file comments

### Requirements

* Pipeline must be triggered by Pull Request
* **Allow scripts to access OAuth token**
* Build Service must have:

  * **Contribute to pull requests**

### Example YAML

```yaml
steps:
- task: ADOCodeReview@2
  inputs:
    api_key: $(OPENAI_API_KEY)
    ai_model: gpt-4o-mini
    bugs: true
    performance: true
    best_practices: true
```

### Supported Features

* Incremental reviews (iteration tracking)
* File include/exclude filters
* Confidence-based filtering
* Deduplication across reruns

### Prototype Publishing Strategy

* Always posts **one PR summary thread**
* Inline comments optional (can be enabled later)
* No fragile changeTrackingId dependency

---

## Confidence & Deduplication (Important)

### Confidence Scale

ADOCodeReview uses **0..1 confidence values**:

* `0.9` = very high confidence
* `0.7` = medium confidence

This applies consistently across:

* Core
* API
* CLI
* Azure DevOps task

### Deduplication

* Prevents repeated findings across files or reruns
* Controlled by similarity threshold (0..1)

---

## Why This Design Works

* ✅ Single review engine (core)
* ✅ Multiple delivery channels
* ✅ Easy local testing (API + CLI)
* ✅ Safe enterprise adoption path (ADO task)
* ✅ Clear evolution path (GitHub, GitLab, Bitbucket)

---

## Roadmap (Optional / Future)

* GitHub & GitLab adapters
* SARIF export
* Security-only mode
* Baseline comparison
* Bot identity tagging for dedupe
* Web UI

---

## License

MIT
