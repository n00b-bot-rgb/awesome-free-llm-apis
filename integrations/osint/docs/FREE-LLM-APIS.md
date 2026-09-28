# Free LLM APIs integration — 2026-09-28

The integration vendors all 16 providers and every concrete model ID from
n00b-bot-rgb/awesome-free-llm-apis at commit
167013ff729e30f3a92bb8d416062d6c34a84507. Catalog date: 2026-08-21.
`SHA256.txt` pins the exact catalog bytes. Quotas, free access and model availability
remain upstream claims, not current verified entitlements.

## Install and use

Python 3.12+; adapter uses only the standard library. Node 20+ is needed only for
the vendored README generator and provider verifier. No model weights or inference
server are included in this repository.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-llm-tested.txt
.venv/bin/invoke llm-status
.venv/bin/invoke llm-test
.venv/bin/invoke llm-probe
```

`llm-status` validates the pinned catalog and lists exact model IDs and missing
environment-variable names. `llm-probe` uses a short synthetic prompt, one model
per provider; it exits 2 if any result is skipped or unsuccessful. Results appear
in `output/llm/probe.json`. This is a smoke test, not an all-model availability test.
No automatic retries, fallback provider, signup, or paid-tier activation occurs.

Set only the selected provider's credentials in your shell or secret manager.
The complete variable-name template is `config/llm.env.example`; the adapter does
not automatically source .env files. Cloudflare also needs CF_ACCOUNT_ID.

Explicit public-text generation:

```bash
.venv/bin/python scripts/llm_providers.py list --provider 'Groq'
# Choose an exact ID from that output and configure GROQ_API_KEY securely.
.venv/bin/python scripts/llm_providers.py chat \
  --provider 'Groq' --model 'openai/gpt-oss-20b' \
  --prompt-file public-prompt.txt --public-data --output output/llm/draft.json
```

`--public-data` is an explicit user attestation, not a content classifier. Never use
it to bypass review of confidential prompts. Output is labeled ai_generated_unverified.
The adapter does not load case files, alter evidence, or run during run-osint.
Other Python components may import `complete`, `catalog`, and `request_for` from
the adapter. Treat returned text as data, never instructions or executable code.

## Protocols and limitations

The adapter covers OpenAI-style chat, Gemini's compatibility path, Cohere v2,
Cloudflare Workers AI and Ollama native chat. It supports single-turn text only;
vision, audio, embeddings, streaming, tools and agent execution are not implemented.
The client limits response size and timeout, rejects redirected requests, uses
provider-specific environment credentials and omits error response bodies from reports.
A successful completion does not prove the request was free or privacy appropriate.

## Updating

Review the upstream commit and current official provider docs, update data.json,
its SHA-256, and UPSTREAM_COMMIT together, then run llm-test and a synthetic probe.
The exact provider set must match ROUTES, so unknown providers fail closed.
Do not silently reinterpret dated quota fields as validated current limits.

## Integration boundary

The existing Invoke tasks, Make targets and integration doctor registry include
this component. Existing intake/enrichment/render commands retain their behavior.
No remote OSINT repositories, iPhone apps, production services, or cloud accounts
are changed by this package. The separate source-repository patch fixes its verifier.
