# .wmpc/capability-registry — a COPY, not a fork

`gate.sh` and `schema.json` here are **byte-for-byte copies** of
`daemon/infrastructure/capability-registry/`. They live in this repo because
this repo's CI cannot read daemon: daemon is private, one gated repo in the
fleet is public, and a cross-repo token would be a new credential surface
(D-0093).

**Fix the canonical copy in daemon, never this one.** daemon's
`infrastructure/capability-registry/test.sh` compares every sibling checkout's
copy to the canonical and goes red when one has drifted — which is the whole
reason a copy is allowed to exist at all.

The gate they power is D-0178 rule 3: a change that adds or alters a callable
capability and does not alter its entry in this repo's root
`capabilities.json` fails. What the gate block triggers on, and whether it
fails open or closed **in this repo**, is declared in that manifest, not here.
