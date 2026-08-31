#!/usr/bin/env bash
# Cheap end-to-end demo: exercises backend / frontend / security, a parallel
# DAG, and the TOPIC-SEGMENT consolidator (2 tasks accumulate on one subject,
# a 3rd on a new subject closes + consolidates the first segment).
#
# Token discipline lives in the AGENT INSTRUCTIONS and the SCOPED PROMPTS below
# ("do the minimum, one file, no tests"), plus a shorter per-node timeout.
#
# Usage:
#   BASE_URL=http://localhost:3000 TOKEN=<APP_AUTH_TOKEN> ./scripts/demo-cheap.sh
# (TOKEN defaults to the APP_AUTH_TOKEN in .env if present.)
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TOKEN="${TOKEN:-$(grep -E '^APP_AUTH_TOKEN=' .env 2>/dev/null | cut -d= -f2- || true)}"
AUTH=(); [ -n "$TOKEN" ] && AUTH=(-H "Authorization: Bearer $TOKEN")

api() { # api METHOD PATH [JSON]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS "${AUTH[@]}" -H 'Content-Type: application/json' -X "$method" \
      --data "$body" "$BASE_URL$path"
  else
    curl -fsS "${AUTH[@]}" -X "$method" "$BASE_URL$path"
  fi
}
jval() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o$1)})"; }

MINIMAL="Prioritize speed and minimalism. Implement only what the task literally asks - no extra endpoints, no error handling beyond what is specified, no comments, no tests, no configs, no dependencies, no refactoring of existing files. Make ONE pass and stop; do not iterate, polish, or add nice-to-haves. In-memory only."

echo "== creating 3 agents =="
BE=$(api POST /api/agents "{\"name\":\"backend\",\"description\":\"Backend HTTP endpoints and in-memory storage in plain Node/JS.\",\"instructions\":\"$MINIMAL\"}" | jval '.agent.id')
FE=$(api POST /api/agents "{\"name\":\"frontend\",\"description\":\"Minimal HTML/JS UI, no frameworks or build tools.\",\"instructions\":\"$MINIMAL\"}" | jval '.agent.id')
SEC=$(api POST /api/agents "{\"name\":\"security\",\"description\":\"Input validation and secret-boundary review, small targeted checks only.\",\"instructions\":\"$MINIMAL\"}" | jval '.agent.id')
echo "  backend=$BE frontend=$FE security=$SEC"

echo "== creating team =="
GID=$(api POST /api/groups "{\"name\":\"Cheap Demo Team\",\"description\":\"Tiny slices to demo the pipeline.\",\"members\":[{\"agentId\":\"$BE\",\"role\":\"backend\"},{\"agentId\":\"$FE\",\"role\":\"frontend\"},{\"agentId\":\"$SEC\",\"role\":\"security\"}]}" | jval '.group.id')
echo "  group=$GID"

run_task() { # run_task "prompt"
  local prompt="$1"
  echo "== task: ${prompt:0:70}... =="
  local tid
  tid=$(api POST "/api/groups/$GID/tasks" "$(node -e "console.log(JSON.stringify({prompt:process.argv[1]}))" "$prompt")" | jval '.task.id')
  echo "  taskId=$tid  (polling until terminal)"
  while :; do
    sleep 5
    local st
    st=$(api GET "/api/groups/$GID/tasks/$tid" | jval '.task.status')
    printf '\r  status=%s        ' "$st"
    case "$st" in completed|failed|partial|cancelled) echo ""; break;; esac
  done
}

# --- Segment 1: subject = "upload" (2 tasks accumulate together) -------------
run_task "In code/, add a POST /upload endpoint that accepts JSON {filename} and returns {id,url}, stored in an in-memory object. Security: reject any filename containing '..' or '/'. Frontend: add a ~10-line code/index.html with a filename input that POSTs to it. Nothing else."
run_task "Add a GET /upload/:id endpoint that returns the stored record as JSON, reusing the existing in-memory store in code/. Do not change anything else."

# --- Segment 2: subject changes = "string util" -> closes + consolidates S1 --
run_task "In code/slug.js add a pure function slugify(text): lowercase, replace non-alphanumeric runs with single hyphens, trim leading/trailing hyphens. No dependencies."

echo ""
echo "== done. Open Teams -> Cheap Demo Team. The upload segment (tasks 1-2)"
echo "   consolidates when task 3 (different subject) starts. Watch the approval"
echo "   cards, then check Workspaces / Ledger. group=$GID"
