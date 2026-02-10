# 📦 `@devops-ai-reviewer/core`

## PR Inspection Assistant – Core Engine

The **core package** contains the provider-agnostic AI code review engine used by all ADOCodeReview adapters (API, CLI, Azure DevOps, future GitHub/GitLab).

It is deliberately isolated from:

* Git
* CI systems
* HTTP servers
* Azure DevOps APIs

---

## Responsibilities

* Orchestrate code reviews per file
* Construct LLM prompts
* Call the injected LLM client (OpenAI / Azure OpenAI)
* Apply:

  * confidence filtering
  * deduplication
  * normalization
* Produce a **stable, normalized review report**

---

## Key Concepts

### ReviewInput

Provider-agnostic review request.

```ts
reviewCode(input: ReviewInput, llmClient: LlmClient)
```

Includes:

* target metadata (repo, PR, commits)
* file diffs (unified diff format)
* review policy
* optional previous comments (for dedupe)

---

### ReviewPolicy

Controls how the review behaves.

```ts
{
  checks: {
    bugs: boolean;
    performance: boolean;
    bestPractices: boolean;
  };
  modifiedLinesOnly: boolean;
  confidence: {
    enabled: boolean;
    minimum: number; // 0..1
  };
  dedupeAcrossFiles: {
    enabled: boolean;
    threshold: number; // 0..1 similarity
  };
}
```

---

### LlmClient

Adapter interface for any LLM provider.

```ts
export interface LlmClient {
  reviewCode(request: LlmReviewRequest): Promise<LlmReviewResponse>;
}
```

Built-in implementations:

* `OpenAiLlmClient`
* `AzureOpenAiLlmClient`

---

## Output

### ReviewReport

```ts
{
  summaryMarkdown: string;
  findings: Finding[];
  filteredOut?: Finding[];
}
```

* Deterministic IDs for deduplication
* Confidence scores in **0..1**
* Severity normalization (`low → critical`)

---

## Why Core Exists

* Single source of truth
* Easy to test (no CI / no Git required)
* Enables multiple delivery channels
* Safe long-term refactoring

---

## Usage Example

```ts
import { reviewCode } from '@devops-ai-reviewer/core';

const report = await reviewCode(input, llmClient);
```
