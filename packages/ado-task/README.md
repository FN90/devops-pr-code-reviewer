# `@devops-ai-reviewer/ado-task`

## Azure DevOps PR Code Reviewer – Azure DevOps Task

The Azure DevOps task runs **ADOCodeReview** automatically on Pull Requests and publishes AI review feedback back to the PR using **stable, iteration-aware comment threads**.

---

## How It Works

1. Triggered by a Pull Request build
2. Detects current and previous PR iterations
3. Collects changed files and diffs
4. Calls the core AI review engine
5. Publishes review results using **one selected comment mode**

---

## Comment Modes

The task supports **one active comment mode per run**, controlled by `comment_mode`:

### **`file` (default)**

* Creates **one thread per file**
* Thread is **file-scoped**, anchored consistently at **line 1**
* Avoids fragile line or range mappings
* Uses `changeTrackingId` to remain stable across iterations, renames, and rebases
* Best choice for reliability and signal-to-noise balance

### **`inline`**

* Creates **inline comments** tied to specific changed lines
* More precise but more fragile if diffs shift
* Intended for future fine-grained feedback scenarios

### **`pr_summary`**

* Creates **a single PR-level summary thread**
* No file or line attachment
* Useful for high-level review feedback only

> ⚠️ Modes are **mutually exclusive**.
> Only the selected `comment_mode` will be published for a given run.

---

## Requirements

* Pipeline must run on a **Pull Request**
* **Allow scripts to access OAuth token** must be enabled
* Build Service permissions:

  * **Contribute to pull requests**

---

## Quick Inputs Map

* `ai_model` – default `o4-mini`; also used as Azure deployment name when `api_endpoint` is set
* `comment_mode` – `file` (default) | `inline` | `pr_summary`
* `max_findings_per_file` – caps findings per file (or per PR summary); `0` = unlimited
* Filters:

  * `file_includes` / `file_excludes`
  * Legacy extension filters
* Quality controls:

  * `confidence_mode` + `confidence_minimum`
  * `dedupe_across_files` + similarity threshold
* Safety & convenience:

  * `modified_lines_only` (default: true)
  * `allow_requeue`
  * `comment_line_correction`
  * `additional_prompts`
  * `verbose_logging`

---

## Example Pipeline YAML

```yaml
steps:
- task: ADOCodeReview@1
  displayName: Run AI code review
  inputs:
    api_key: $(OPENAI_API_KEY)
    ai_model: o4-mini
    comment_mode: file            # file | inline | pr_summary
    max_findings_per_file: 5      # 0 = unlimited
    bugs: true
    performance: true
    best_practices: true
    modified_lines_only: true
    # Azure OpenAI (optional):
    # api_endpoint: https://my-foundry-project.openai.azure.com/
    # api_version: 2024-10-21
```

---

## Supported Features

* **Stable file-level review threads** (default)
* Inline or PR-summary-only review modes
* Max-findings throttling per file or summary
* Iteration-aware incremental reviews with requeue protection
* File include/exclude filtering and extension filters
* Confidence gating and cross-file deduplication
* OpenAI and Azure OpenAI support

---

## Design Notes (Why File-Level Line 1 Anchoring)

* Azure DevOps only treats a thread as *file-attached* when `threadContext.filePath` is present
* A single-line anchor at **line 1** avoids:

  * Broken range mappings
  * Diff-shift 400 errors
  * Inline comment drift
* `changeTrackingId` ensures the thread follows the file across PR iterations

This makes **file mode the most robust and enterprise-safe default**.

---



## Adding the OpenAI API Key to Azure DevOps Pipelines

For security reasons, the OpenAI (or Azure OpenAI) API key **must be stored as a secret variable** and **never hard-coded** in pipeline YAML.

### Step 1 – Open the Library

1. In Azure DevOps, go to your **Project**
2. Navigate to **Pipelines → Library**
3. Select **Variable groups**
4. Click **+ Variable group**

---

### Step 2 – Create a Variable Group

1. Give the group a name, for example:

   ```
   openai-secrets
   ```
2. Click **+ Add** to create a variable:

   * **Name**: `OPENAI_API_KEY`
   * **Value**: your OpenAI or Azure OpenAI API key
3. Toggle **Keep this value secret** ✅
4. Click **Save**

> 🔒 Once marked as secret, the value is masked in logs and cannot be read back.

---

### Step 3 – Grant Pipeline Access

In the same variable group:

1. Enable **Allow access to all pipelines**
   **OR**
2. Manually authorize the specific pipeline that will run the task

This step is required, otherwise the pipeline will fail at runtime.

---

### Step 4 – Reference the Secret in Pipeline YAML

Link the variable group and pass the key to the task:

```yaml
variables:
- group: openai-secrets

steps:
- task: ADOCodeReview@1
  displayName: Run AI code review
  inputs:
    api_key: $(OPENAI_API_KEY)
    ai_model: o4-mini
    comment_mode: file
```

Azure DevOps will securely inject the key at runtime.

---

### Azure OpenAI (Optional)

If you are using **Azure OpenAI**, you still store the API key the same way.

Only the endpoint and API version change:

```yaml
inputs:
  api_key: $(OPENAI_API_KEY)
  api_endpoint: https://my-foundry-project.openai.azure.com/
  api_version: 2024-10-21
  ai_model: my-azure-deployment-name
```

---

### Common Pitfalls

* ❌ Forgetting to mark the variable as **secret**
* ❌ Not authorizing the pipeline to access the variable group
* ❌ Hard-coding the API key in YAML or source control
* ❌ Using the wrong variable name (case-sensitive)

---

### Security Notes

* Secret variables are **masked in logs**
* The task never persists or echoes the API key
* Recommended: rotate API keys periodically

---

## Notes for Enterprises

* TLS verification enabled by default
* OAuth usage follows Azure DevOps best practices
* Designed for extensibility rather than hard-wired behavior

---

## Next Steps (Optional)

* Smarter inline placement heuristics
* Bot identity tagging
* SARIF export
* GitHub / GitLab adapters

