"""Thin wrapper so non-run.py modules can load policy.json without circular imports."""
import json
from pathlib import Path

POLICY_FILE = Path(__file__).parent / "policy.json"


def load_policy() -> dict:
    with open(POLICY_FILE) as f:
        return json.load(f)
