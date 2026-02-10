# 🖥️ `@devops-ai-reviewer/cli`

## PR Inspection Assistant – CLI

The CLI allows running ADOCodeReview directly against Git repositories.

### Use cases

* Local testing
* CI pipelines outside Azure DevOps
* Pre-commit or pre-push hooks
* Debugging diffs and prompts

---

## Install (local dev)

```bash
cd packages/cli
npm install
npm link
```

---

## Run Against Git Commits

```bash
review-cli \
  --base origin/main \
  --head HEAD \
  --format markdown \
  --fail-on high
```

---

## Supported Options

| Flag               | Description                 |        |      |           |
| ------------------ | --------------------------- | ------ | ---- | --------- |
| `--base`           | Base commit or branch       |        |      |           |
| `--head`           | Head commit                 |        |      |           |
| `--format`         | `markdown` or `json`        |        |      |           |
| `--fail-on`        | `low                        | medium | high | critical` |
| `--include`        | Include glob patterns       |        |      |           |
| `--exclude`        | Exclude glob patterns       |        |      |           |
| `--ext`            | Allowed file extensions     |        |      |           |
| `--confidence-min` | Confidence threshold (0..1) |        |      |           |

---

## Exit Codes

* `0` → no blocking findings
* `1` → at least one finding meets severity threshold

This makes the CLI CI-friendly.

---

## Notes

* Uses the same core engine as API and ADO
* Git diffs are computed locally
* No Azure DevOps dependency