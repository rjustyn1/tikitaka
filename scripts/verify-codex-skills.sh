#!/usr/bin/env sh
# Verifies the A1 assumption: repo-scoped skills are discovered per-workspace and
# do not leak across workspaces. Uses the codex app-server skills/list RPC, so it
# needs NO API key and costs nothing.
#
# Run inside the runtime image:
#   docker run --rm -v "$PWD/scripts/verify-codex-skills.sh:/v.sh" \
#     --entrypoint sh volc-agent-launchpad:local /v.sh
set -e
export CODEX_HOME=${CODEX_HOME:-/tmp/verify-ch}
W=${W:-/tmp/verify-w}
mkdir -p "$CODEX_HOME/skills" "$W/agent-with-skill/.agents/skills/probe-skill" "$W/agent-empty"

cat > "$W/agent-with-skill/.agents/skills/probe-skill/SKILL.md" <<'S'
---
name: probe-skill
description: Probe skill used to verify per-workspace skill isolation.
---
body
S

printf '%s\n' \
  '{"method":"initialize","id":1,"params":{"clientInfo":{"name":"verify","title":null,"version":"1"},"capabilities":null}}' \
  > /tmp/rpc.jsonl
printf '{"method":"skills/list","id":2,"params":{"cwds":["%s","%s"]}}\n' \
  "$W/agent-with-skill" "$W/agent-empty" >> /tmp/rpc.jsonl

OUT=$( { cat /tmp/rpc.jsonl; sleep 3; } | codex app-server 2>/dev/null )

echo "$OUT" | grep -q '"name":"probe-skill".*"scope":"repo"' \
  && echo "PASS  repo-scoped skill discovered in its own workspace" \
  || { echo "FAIL  repo-scoped skill NOT discovered - A1 assumption broken"; exit 1; }

# The empty workspace's entry must not contain the probe skill.
echo "$OUT" | tr '{' '\n' | grep -A0 'agent-empty' >/dev/null 2>&1 || true
if echo "$OUT" | sed 's/.*agent-empty//' | grep -q 'probe-skill'; then
  echo "FAIL  probe-skill leaked into the empty workspace - isolation broken"; exit 1
else
  echo "PASS  empty workspace sees no repo skills - no cross-agent leakage"
fi
echo
echo "Reminder: this proves DISCOVERY. That codex exec FIRES a skill still needs"
echo "one live run with a valid ARK_API_KEY."
