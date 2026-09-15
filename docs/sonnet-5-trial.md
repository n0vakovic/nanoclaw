# Sonnet 5 trial

The shared agent runner defaults to `claude-sonnet-5`, with Agent SDK
`thinking: { type: 'adaptive' }` and `effort: 'medium'`. This affects new
foreground, group, scheduled and detached executions. Existing containers keep
the source copied at their startup. Personality instructions, sessions, history
and memory are unchanged. There is no new model command or automatic expiry.

The existing container's Agent SDK 0.2.76 / bundled CLI 2.1.76 passed a live
Sonnet 5 response and read-only Bash tool check through the credential proxy.
No dependency or image upgrade was required.

## Revert when requested

The pre-trial baseline is commit `6e26e82c` (which includes the diagnostics fix).
Find the model-only commit titled `Try Sonnet 5 with adaptive thinking at medium effort`
and revert that commit, preserving later unrelated changes. Restore both the query
model default and the diagnostic model default to `claude-sonnet-4-6`, and remove
only the explicit trial `thinking` and `effort` options. Do not substitute disabled
thinking: the original SDK behavior had neither option set.

Commit and push the revert. Build the agent runner, wait for useful active work
to finish, then run `scripts/deploy-main.sh` from clean main. Idle containers can
be closed using the existing IPC `_close` sentinel; never kill useful work to
accelerate the switch. Confirm the actual assistant model in the resumed session's
JSONL on its next turn. Preserve all conversation and memory files, including
anything written during the trial. Reverting code does not undo agent actions.

The host `.env` alone does not switch the model: it does not forward `CLAUDE_MODEL`
to containers. On znacharch, runtime inspection must use the service's rootless
Docker endpoint from `DOCKER_HOST`, not the system Docker socket.
