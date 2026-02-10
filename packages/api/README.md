

# 🌐 `@devops-ai-reviewer/api`

## PR Inspection Assistant – HTTP API

The API package exposes the ADOCodeReview core engine over HTTP.

### Use cases

* Postman testing
* Internal services
* Web UI backends
* Non-Git integrations

---

## Start the API

```bash
cd packages/api
npm install
npm run dev
```

Runs on `http://localhost:3000`

---

## Environment Variables

### OpenAI

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

### Azure OpenAI

```bash
AZURE_OPENAI_ENDPOINT=https://xxx.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=my-deployment
AZURE_OPENAI_API_VERSION=2024-10-21
```

---

## Endpoint

### `POST /review`

#### Example Request

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

---

#### Example Response

```json
{
  "summaryMarkdown": "Findings: 2 (0 filtered out, total generated 2).",
  "findings": [ ... ],
  "filteredOut": []
}
```

---

## Notes

* The API **does not** store state
* All behavior is driven by the request payload
* Ideal for validating prompts and policies before CI integration