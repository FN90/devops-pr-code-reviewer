# 🔁 `@devops-ai-reviewer/ado-task`

## PR Inspection Assistant – Azure DevOps Task

The Azure DevOps task runs ADOCodeReview automatically on Pull Requests and posts review comments back to the PR.

---

## How It Works

1. Triggered by a PR build
2. Detects PR iterations
3. Collects changed files and diffs
4. Calls the core review engine
5. Publishes:

   * One **PR summary comment**
   * Optional inline file comments

---

## Requirements

* Pipeline must run on Pull Request
* **Allow scripts to access OAuth token**
* Build Service permissions:

  * ✅ Contribute to pull requests

---

## Example Pipeline YAML

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

---

## Supported Features

* Incremental reviews (iteration tracking)
* File include / exclude filtering
* Confidence-based filtering (0..1)
* Deduplication across reruns
* Azure OpenAI or OpenAI support

---

## Prototype Publishing Strategy

For reliability:

* Always publishes **one PR-level summary thread**
* Inline comments are optional and can be enabled later
* Avoids fragile `changeTrackingId` logic in early versions

---

## Notes for Enterprises

* TLS verification is enabled by default
* OAuth token usage follows ADO best practices
* Designed to be extended, not hard-wired

---

## Next Steps (Optional)

* Precise inline comment placement
* Bot identity tagging
* SARIF export
* GitHub / GitLab adapters