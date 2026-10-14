#!/usr/bin/env bash
# gate.sh — the ONE capability-manifest validator, and the per-repo registration
# gate it powers (D-0178 ship 1).
#
# CANONICAL COPY: daemon/infrastructure/capability-registry/gate.sh
# Every gated repo carries a byte-for-byte copy at
#   <repo>/.wmpc/capability-registry/{gate.sh,schema.json}
# because a repo's CI cannot read daemon (daemon is private, one gated repo is
# public, and a cross-repo token would be a new credential surface — D-0093).
# The copy is NOT a fork: daemon's test.sh fails if any sibling checkout's copy
# differs from this file. Fix it HERE, never in a repo's copy — the same rule
# wmpc-meta's pr-linked-issue.yml already states about itself.
#
# WHAT IT REFUSES
#   validate  — a manifest that does not match schema.json, plus the rules JSON
#               Schema cannot state: one honest gate shape, unique names, an
#               `input` that is not a closed object, an `invoke` missing the
#               fields its own kind needs, an `auth` block holding a credential
#               VALUE instead of a name, a `does` sentence carrying ids/codes/
#               system names (D-0054), a url with a secret in its query.
#   gate      — a diff that touches one of the manifest's own `gate.triggers`
#               and does not touch capabilities.json (D-0178 rule 3). A manifest
#               declaring `gate.none` skips this and says why.
#
# WHAT IT CANNOT REFUSE, stated rather than claimed (D-0178 "Enforced by"):
# a `does` sentence that is wrong, an `effect: read` on an endpoint that writes,
# or an untrue `idempotent: true`. A mislabelled `effect` is this design's
# highest-consequence defect and its only defence is a human reading every
# manifest change.
#
# Usage:
#   gate.sh validate [<manifest>] [--schema <schema.json>]
#   gate.sh gate     [<manifest>] --changed-list <file> [--schema <schema.json>]
#   gate.sh ci       [--base <ref>] [--repo <dir>]      # validate + gate, for CI
#   gate.sh schema-path                                 # print the schema it uses
#
# Exit 0 = clean. Exit 1 = refused (reasons on stdout). Exit 2 = cannot run.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_DEFAULT="$HERE/schema.json"

die(){ printf 'capability-gate: %s\n' "$*" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || die "jq is required"

# ---------------------------------------------------------------------------
# The schema-subset validator, in jq.
#
# It implements EXACTLY these JSON Schema keywords: type, const, enum, required,
# properties, additionalProperties(false), items, minItems, minLength, pattern,
# plus the annotations $schema/$id/title/description. Anything else in
# schema.json is a hard error rather than a silently ignored constraint — the
# schema must never be able to outgrow the thing that enforces it.
# ---------------------------------------------------------------------------
read -r -d '' VALIDATE_JQ <<'JQ'
def kws: ["$schema","$id","title","description","type","const","enum","required",
          "properties","additionalProperties","items","minItems","minLength","pattern"];

def schema_kw_errs($s; $path):
  if ($s|type) != "object" then "schema at \($path): expected an object" else
    ( $s | keys_unsorted[] as $k | select((kws | index($k)) == null)
      | "schema at \($path): unsupported keyword \"\($k)\" — gate.sh does not enforce it" ),
    ( if ($s|has("additionalProperties")) and (($s.additionalProperties|type) != "boolean")
      then "schema at \($path): additionalProperties must be true or false" else empty end ),
    ( ($s.properties // {}) | keys_unsorted[] as $k
      | schema_kw_errs($s.properties[$k]; "\($path).\($k)") ),
    ( if ($s|has("items")) then schema_kw_errs($s.items; "\($path)[]") else empty end )
  end;

def type_ok($t; $v):
  ($v|type) == $t
  or ($t == "integer" and ($v|type) == "number" and ($v|floor) == $v);

def errs($s; $v; $path):
  ( if ($s|has("type")) then
      (($s.type | if type == "array" then . else [.] end) as $ts
       | if any($ts[]; . as $t | type_ok($t; $v)) then empty
         else "\($path): expected \($s.type|tojson), got \($v|type)" end)
    else empty end ),
  ( if ($s|has("const")) and $v != $s.const
    then "\($path): must be \($s.const|tojson)" else empty end ),
  ( if ($s|has("enum")) and (($s.enum|index($v)) == null)
    then "\($path): \($v|tojson) is not one of \($s.enum|tojson)" else empty end ),
  ( if ($s|has("minLength")) and ($v|type) == "string" and ($v|length) < $s.minLength
    then "\($path): needs at least \($s.minLength) characters" else empty end ),
  ( if ($s|has("pattern")) and ($v|type) == "string" and (($v|test($s.pattern)) | not)
    then "\($path): \($v|tojson) does not match \($s.pattern)" else empty end ),
  ( if ($s|has("minItems")) and ($v|type) == "array" and ($v|length) < $s.minItems
    then "\($path): needs at least \($s.minItems) item(s)" else empty end ),
  ( if ($v|type) == "object" then
      ( ($s.required // [])[] as $k
        | if ($v|has($k)) then empty else "\($path): missing required field \"\($k)\"" end ),
      ( if ($s.additionalProperties == false) then
          ( $v | keys_unsorted[] as $k
            | if (($s.properties // {}) | has($k)) then empty
              else "\($path): unknown field \"\($k)\"" end )
        else empty end ),
      ( ($s.properties // {}) | keys_unsorted[] as $k
        | if ($v|has($k)) then errs($s.properties[$k]; $v[$k]; "\($path).\($k)") else empty end )
    else empty end ),
  ( if ($v|type) == "array" and ($s|has("items")) then
      ( range($v|length) as $i | errs($s.items; $v[$i]; "\($path)[\($i)]") )
    else empty end );

# ---- the rules JSON Schema cannot state -----------------------------------
def gate_errs:
  (.gate // {}) as $g
  | ( ($g|has("none")) as $none
      | (($g|has("triggers")) or ($g|has("granularity")) or ($g|has("on_undetectable"))) as $paths
      | if $none and $paths then
          "$.gate: declares BOTH a `none` reason and trigger paths — pick one"
        elif $none then empty
        elif $paths then
          ( ["triggers","granularity","on_undetectable"][] as $k
            | select(($g|has($k)) | not)
            | "$.gate: a path gate needs \"\($k)\" too" )
        else
          "$.gate: declare either trigger paths or `none` with a reason (D-0178 rule 3)"
        end );

def name_errs:
  ( [.capabilities[]?.name] as $n
    | $n | group_by(.) | map(select(length > 1) | .[0])[]
    | "$.capabilities: name \"\(.)\" is used twice — a name is a natural key" );

def entry_errs:
  ( range(.capabilities|length) as $i
    | (.capabilities[$i]) as $c
    | "$.capabilities[\($i)] (\($c.name // "unnamed"))" as $p
    | (
        # input must be a closed object schema — a cached route's arguments are
        # validated against it before any call (D-0178 rule 6).
        ( if ($c.input.type? // "") != "object"
          then "\($p).input: must be a JSON Schema of type \"object\"" else empty end ),
        ( if (($c.input|type) == "object") and (($c.input|has("additionalProperties")) | not
              or ($c.input.additionalProperties != false))
          then "\($p).input: must set additionalProperties:false" else empty end ),

        # invoke: each kind needs its own fields, and may not carry another's.
        ( ({"http":["method","url"],"command":["command","host"],
            "mcp_tool":["tool","endpoint"],"executor_kind":["executor_kind"]}) as $need
          | ($need[$c.invoke.kind // ""] // []) as $req
          | ( $req[] as $k | select((($c.invoke)|has($k)) | not)
              | "\($p).invoke: kind \"\($c.invoke.kind)\" needs \"\($k)\"" ),
            ( (($need | to_entries | map(.value) | flatten) - $req | unique)[] as $foreign
              | select(($c.invoke)|has($foreign))
              | "\($p).invoke: \"\($foreign)\" does not belong to kind \"\($c.invoke.kind)\"" ) ),

        # auth holds NAMES, never values (D-0093).
        ( if (($c.auth.env // "") | type) == "string" and (($c.auth.env|length) > 0)
             and (($c.auth.env | test("^[A-Z][A-Z0-9_]*$")) | not)
          then "\($p).auth.env: \"\($c.auth.env)\" is not an env var NAME — a manifest never holds a credential value (D-0093)"
          else empty end ),
        ( if (($c.auth.header // "") | type) == "string" and (($c.auth.header|length) > 0)
             and (($c.auth.header | test("^[A-Za-z][A-Za-z0-9-]{1,40}$")) | not)
          then "\($p).auth.header: \"\($c.auth.header)\" is not a header NAME"
          else empty end ),
        ( if ($c.auth.kind == "api_key") and (($c.auth.env // "") == "")
          then "\($p).auth: an api_key capability must name the env var that holds it"
          else empty end ),

        # a url must not carry a secret in its query string.
        ( if (($c.invoke.url // "") | test("[?&](key|token|secret|password|apikey)="; "i"))
          then "\($p).invoke.url: a credential in a query string is a leak — name it in `auth`"
          else empty end ),

        # `does` is read by a person and by the brain: plain language (D-0054).
        # This refuses the FORM, never the truth of the sentence.
        ( ($c.does // "") as $d
          | ( if ($d | test("^[A-Z]")) | not then "\($p).does: start with a capital letter" else empty end ),
            ( if ($d | test("\\.$")) | not then "\($p).does: write one sentence ending in a full stop" else empty end ),
            ( if $d | test("https?://") then "\($p).does: no urls — plain words only (D-0054)" else empty end ),
            ( if $d | test("#[0-9]") then "\($p).does: no issue numbers (D-0054)" else empty end ),
            ( if $d | test("\\b[a-z0-9]+_[a-z0-9_]+\\b") then "\($p).does: no snake_case identifiers (D-0054)" else empty end ),
            ( if $d | test("\\b[A-Z]{3,}\\b") then "\($p).does: no codes or acronyms in caps (D-0054)" else empty end ),
            ( if $d | test("\\b(D-[0-9]{4}|supabase|cloudflare|launchd|wrangler|courtreserve_api|cos_[a-z_]+)\\b"; "i")
              then "\($p).does: no system or repo names (D-0054)" else empty end ) ),

        # whitelist_key is a key, or an explicit null. Never a sentence.
        ( if (($c.whitelist_key // null) | type) == "string"
             and (($c.whitelist_key | test("^[a-z][a-z0-9_]*$")) | not)
          then "\($p).whitelist_key: \"\($c.whitelist_key)\" is not a whitelist key"
          else empty end ),

        # an empty example is worse than none: it is few-shot material.
        ( range($c.examples|length) as $j
          | select((($c.examples[$j]) | test("[a-z]")) | not)
          | "\($p).examples[\($j)]: write a real ask" )
      ) );

# ---- entry point ----------------------------------------------------------
[ schema_kw_errs($schema; "$") ] as $kw
| if ($kw | length) > 0 then $kw[]
  else
    [ errs($schema; .; "$") ] as $se
    | if ($se | length) > 0 then $se[]
      else ( gate_errs, name_errs, entry_errs )
      end
  end
JQ

# ---------------------------------------------------------------------------
validate_manifest(){ # $1=manifest $2=schema
  local manifest="$1" schema="$2" out rc
  [ -f "$manifest" ] || { echo "no manifest at $manifest"; return 1; }
  [ -f "$schema" ]   || { echo "no schema at $schema"; return 1; }
  jq -e . "$manifest" >/dev/null 2>&1 || { echo "$manifest is not valid JSON"; return 1; }
  jq -e . "$schema"   >/dev/null 2>&1 || { echo "$schema is not valid JSON"; return 1; }
  out="$(jq -r --slurpfile s "$schema" '$s[0] as $schema | '"$VALIDATE_JQ" "$manifest" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then echo "validator errored: $out"; return 1; fi
  if [ -n "$out" ]; then printf '%s\n' "$out"; return 1; fi
  return 0
}

# The registration gate: a diff that touches a trigger must touch the manifest.
run_gate(){ # $1=manifest $2=changed-list-file ("" = undetectable) $3=manifest repo-relative path
  local manifest="$1" changed="$2" relpath="$3" none triggers undetect hit
  none="$(jq -r '.gate.none // empty' "$manifest")"
  if [ -n "$none" ]; then
    echo "gate: none — $none"
    echo "gate: skipped by the manifest's own declaration (D-0178 rule 3)."
    return 0
  fi
  undetect="$(jq -r '.gate.on_undetectable // "fail_open"' "$manifest")"
  if [ -z "$changed" ] || [ ! -s "$changed" ]; then
    if [ "$undetect" = "fail_closed" ]; then
      echo "gate: cannot tell what this diff changed, and this repo declares fail_closed."
      return 1
    fi
    echo "gate: cannot tell what this diff changed; this repo declares fail_open — passing."
    return 0
  fi
  triggers="$(jq -r '.gate.triggers[]' "$manifest")"
  hit=""
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      # shellcheck disable=SC2254
      case "$f" in ($pat) hit="$hit$f ($pat)
";; esac
    done <"$changed"
  done <<<"$triggers"
  if [ -z "$hit" ]; then
    echo "gate: no capability trigger path in this diff."
    return 0
  fi
  if grep -qxF "$relpath" "$changed"; then
    echo "gate: a trigger changed and $relpath changed with it."
    return 0
  fi
  echo "gate: this diff changes a capability surface but not $relpath:"
  printf '%s' "$hit" | sed 's/^/  /'
  echo "A change that adds or alters a callable capability must alter its manifest entry in the SAME change (D-0178 rule 3)."
  echo "If the diff touched no capability, say so by touching nothing here — move the change out of the trigger path, or widen the manifest's own gate block and say why."
  return 1
}

mode="${1:-}"; shift 2>/dev/null || true
manifest=""; schema="$SCHEMA_DEFAULT"; changed=""; base=""; repo=""
while [ $# -gt 0 ]; do
  case "$1" in
    --schema)       schema="${2:?}"; shift 2 ;;
    --changed-list) changed="${2:?}"; shift 2 ;;
    --base)         base="${2:?}"; shift 2 ;;
    --repo)         repo="${2:?}"; shift 2 ;;
    -*)             die "unknown flag $1" ;;
    *)              manifest="$1"; shift ;;
  esac
done

case "$mode" in
  schema-path) echo "$schema" ;;
  validate)
    [ -n "$manifest" ] || manifest="$(git rev-parse --show-toplevel 2>/dev/null)/capabilities.json"
    if validate_manifest "$manifest" "$schema"; then
      echo "capability manifest ok: $(jq -r '.capabilities|length' "$manifest") capabilit(y/ies) in $manifest"
    else
      echo "REFUSED: $manifest"; exit 1
    fi ;;
  gate)
    [ -n "$manifest" ] || manifest="$(git rev-parse --show-toplevel 2>/dev/null)/capabilities.json"
    run_gate "$manifest" "$changed" "capabilities.json" || exit 1 ;;
  ci)
    [ -n "$repo" ] || repo="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not in a git checkout"
    manifest="$repo/capabilities.json"
    rc=0
    echo "--- validate"
    validate_manifest "$manifest" "$schema" || rc=1
    [ "$rc" -eq 0 ] && echo "ok: $(jq -r '.capabilities|length' "$manifest") capabilit(y/ies)"
    echo "--- gate"
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    if [ -n "$base" ] && git -C "$repo" rev-parse --verify "$base" >/dev/null 2>&1; then
      git -C "$repo" diff --name-only "$base"...HEAD >"$tmp" 2>/dev/null || : >"$tmp"
    else
      : >"$tmp"
      echo "gate: no usable base ref (asked for \"${base:-none}\")."
    fi
    run_gate "$manifest" "$tmp" "capabilities.json" || rc=1
    exit "$rc" ;;
  *)
    sed -n '/^# Usage:/,/^# Exit/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2 ;;
esac
