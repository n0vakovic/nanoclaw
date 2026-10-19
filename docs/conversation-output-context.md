# Voice mode and delivered output context

## Voice mode (#201)

When the user asks to enter or leave voice mode, the live agent calls
`enter_voice_mode` or `exit_voice_mode`. The tool prints `[VOICE MODE ACTIVE]`
or `[VOICE MODE DEACTIVATED]`. State is per chat and persists in the IPC mount
across sessions and service restarts.

In active mode, incoming Telegram voice messages carry explicit modality metadata
through storage and prompt formatting. A Stop hook reminds the agent if it has
not successfully delivered a voice reply. Text may accompany voice. Text sends
also return the active-mode rule to the agent. There is no automatic conversion
of text replies to speech, and sending voice messages alone does not toggle mode.

Voice delivery is acknowledged by the host only after the channel succeeds.
The Stop hook blocks once per incoming voice burst, allowing the agent to recover
without looping forever when speech generation or delivery is unavailable.
Mode remains active after a failure.

## Delivered output context (#202)

Confirmed text deliveries from scheduled tasks, background jobs, live responses,
and message tools are saved as bot messages. They are excluded from inbound
polling, so saving an output cannot trigger a conversation or advance its cursor.

Both initial and piped live prompts include up to five recent delivered outputs,
with a shared 24,000-character content budget. Historical content is XML escaped
and labeled as evidence. `read_chat_outputs` retrieves full outputs by ID or
lists older outputs using a timestamp. Host-side routing scopes retrieval to the
requesting chat; the agent cannot supply another chat ID.

Recording starts with deployment. Older task logs are not backfilled as delivery
evidence because a completed task does not prove that its output reached the user.
