#!/usr/bin/env python3
"""Regenerate the TS parity goldens from the Python recommender.

The goldens in ts/tests/fixtures/ are the reference the TS recommender is held
to. They are produced HERE, by running the Python engine over the checked-in
fixture policy + schedule, so a deliberate behaviour change is re-baselined by
re-running this rather than hand-editing JSON.

    python scripts/regen_goldens.py          # rewrite goldens + manifest n_recs
    python scripts/regen_goldens.py --check   # exit 1 if any golden is stale
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FX = ROOT / "ts" / "tests" / "fixtures"
sys.path.insert(0, str(ROOT))

import recommender  # noqa: E402
from history_analysis import load_popularity  # noqa: E402
from recommender import recommend  # noqa: E402


def main() -> int:
    check = "--check" in sys.argv
    policy = json.loads((FX / "policy.json").read_text())
    schedule = json.loads((FX / "schedule.json").read_text())
    manifest = json.loads((FX / "manifest.json").read_text())

    stale = []
    for entry in manifest:
        items = [] if entry.get("schedule") == "empty" else schedule
        # A `popularity` entry runs the engine over a history fixture instead of
        # whatever history happens to sit on the machine. `recommend` reads the
        # popularity map through the module-level `load_popularity`, so this is
        # patched rather than passed. golden_history_2026-07-13 used to be made
        # by hand, which meant a deliberate behaviour change (the court->capacity
        # table, 2026-11-13) left it stale with no script able to re-baseline it.
        if entry.get("popularity"):
            fixture = FX / entry["popularity"]
            recommender.load_popularity = lambda _=None, _f=fixture: load_popularity(_f)
        else:
            recommender.load_popularity = load_popularity
        recs, stats = recommend(items, entry["date"], policy, llm=False)
        golden = {
            "date": entry["date"],
            **({"schedule": entry["schedule"]} if entry.get("schedule") else {}),
            "recs": [r.to_dict() for r in recs],
            "stats": stats,
        }
        path = FX / f"golden_{entry['label']}.json"
        new = json.dumps(golden, indent=2, ensure_ascii=False) + "\n"
        old = path.read_text() if path.exists() else ""
        if new != old:
            stale.append(path.name)
            if not check:
                path.write_text(new)
        entry["n_recs"] = len(recs)

    if not check:
        (FX / "manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
        )

    if check and stale:
        print("STALE goldens: " + ", ".join(stale))
        return 1
    print(("would rewrite: " if check else "rewrote: ") + (", ".join(stale) or "nothing"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
