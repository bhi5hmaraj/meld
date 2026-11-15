#!/bin/sh
# Codex for a meld worker: the Codex that the ACP adapter runs, with the permission profile meld-worker. The profile
# extends the workspace profile of Codex with the network, local ports, and the caches of uv and npm, so that the
# usual checks pass in the sandbox at the first try. MELD_REAL_CODEX is the Codex path of the person, when set.
exec "${MELD_REAL_CODEX:-codex}" "$@" \
  -c 'default_permissions="meld-worker"' \
  -c 'permissions.meld-worker.extends=":workspace"' \
  -c 'permissions.meld-worker.network.enabled=true' \
  -c 'permissions.meld-worker.network.allow_local_binding=true' \
  -c "permissions.meld-worker.filesystem={\"$HOME/.cache\"=\"write\", \"$HOME/.npm\"=\"write\"}"
