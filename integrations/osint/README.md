# Python pipeline adapter

Standalone tested copy of the integration installed into the saved OSINT pipeline.
Run from this directory:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-llm-tested.txt
.venv/bin/invoke llm-status
.venv/bin/invoke llm-test
.venv/bin/invoke llm-probe
```

Probe exits 2 when credentials are missing or any live request fails. Catalog data
is pinned to the original commit; this does not certify model availability or free
pricing. See docs/FREE-LLM-APIS.md for protocols, explicit generation and limitations.
For another existing pipeline, merge these three Invoke tasks and register the
adapter in its integration registry. Do not replace an existing tasks.py wholesale.
No case data is included here.
