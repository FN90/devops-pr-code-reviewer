# DevOps AI Code Reviewer

DevOps AI Code Reviewer is an **Azure DevOps Pipelines task** that automatically reviews **Pull Requests** using **OpenAI** or **Azure OpenAI**.

It analyzes the PR diff and posts actionable feedback into the PR conversation:
- 🐞 Bug risks and logic issues
- 🔒 Security issues (injection, auth mistakes, hardcoded secrets, unsafe patterns)
- ⚡ Performance bottlenecks
- ✅ Best-practices and maintainability improvements

> This extension is designed as a **simple prototype first**, then can be extended with richer commenting strategies and rules.

---

## What it does

When a pipeline is triggered by a Pull Request, the task:

1. Detects the PR context (repo, PR id, iteration range)
2. Collects changed files for the latest PR iteration(s)
3. Fetches unified diffs for the selected files
4. Sends diffs to the configured LLM (OpenAI or Azure OpenAI)
5. Publishes a review summary (and optionally per-finding threads) back to the PR

---

## Requirements

### Pipeline prerequisites
- Pipeline must run on **Pull Request** builds
- Enable **Allow scripts to access the OAuth token**
  - This is required to use `System.AccessToken` for Azure DevOps REST API calls

### Permissions
The pipeline identity (Build Service) must have permission to comment on PRs:
- **Contribute to pull requests**

---

## Configuration

### OpenAI
Provide:
- `api_key`: OpenAI API key
- `ai_model`: model name (example: `gpt-4o-mini`)

### Azure OpenAI
Provide:
- `api_key`: Azure OpenAI key
- `api_endpoint`: your Azure OpenAI endpoint  
  Example: `https://<resource>.openai.azure.com/`
- `api_version`: API version  
  Example: `2024-10-21`
- `ai_model`: your **deployment name**

---

## Example YAML (Pull Request pipeline)

```yaml
trigger: none

pr:
  branches:
    include:
    - main

jobs:
- job: AiReview
  pool:
    vmImage: ubuntu-latest
  steps:
  - checkout: self
    persistCredentials: true

  - task: ADOCodeReview@1
    inputs:
      api_key: $(OPENAI_API_KEY)
      ai_model: gpt-4o-mini
      bugs: true
      performance: true
      best_practices: true
      modified_lines_only: true
      allow_requeue: false
````

> If you use Azure OpenAI, also set: `api_endpoint`, `api_version`, and ensure `ai_model` matches your deployment.

---

## File filtering (optional)

You can narrow the review scope with:

* Include extensions (example: `.ts,.cs,.js`)
* Exclude extensions
* Include files (glob patterns)
* Exclude files (glob patterns)

This helps reduce noise and token usage.

---

## Notes & limitations (prototype)

* Initial versions prioritize a **PR-level summary comment** (reliable)
* Inline comment placement can be improved later with richer PR change tracking (e.g., changeTrackingId mapping)
* Large diffs may be skipped if they exceed token or size guardrails

---

## Support

Project repository: [https://github.com/FN90/devops-ai-reviewer](https://github.com/FN90/devops-ai-reviewer)

For issues, feature requests, and improvements, open a GitHub issue or PR.