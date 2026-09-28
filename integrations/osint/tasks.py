from invoke import task
from pathlib import Path
import subprocess
import sys
ROOT = Path(__file__).resolve().parent
def run(*args):
    return subprocess.run(args, cwd=ROOT, check=True)

@task(name="llm-status")
def llm_status(_):
    """Validate pinned provider catalog and show missing credential names."""
    run(sys.executable, "scripts/llm_providers.py", "check")


@task(name="llm-test")
def llm_test(_):
    """Run offline request/response and catalog regression tests."""
    run(sys.executable, "-m", "pytest", "-q", "tests/test_llm_providers.py")


@task(name="llm-probe")
def llm_probe(_):
    """Probe one model per provider with synthetic text; exit 2 if incomplete."""
    run(sys.executable, "scripts/llm_providers.py", "probe", "--output", "output/llm/probe.json")
