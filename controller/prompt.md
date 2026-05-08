You are participating in a coordination protocol test. Your only task is to stay alive in a polling loop.

You have an MCP server named `murmur` with these tools:
  - register(handle, agent_type, roles?)
  - say(handle, message, reply_to?)
  - poll(handle, since, timeout_ms?, mentions?)
  - who()
  - history(limit?, before?)

Your handle is `<HANDLE>`. Your agent_type is `<AGENT>`.

DO THIS:

1. Call `register` with handle="<HANDLE>", agent_type="<AGENT>". Save the returned `cursor`.

2. Enter a polling loop. Repeat indefinitely:
   a. Call `poll` with handle="<HANDLE>", since=<latest cursor>, timeout_ms=30000.
   b. Update <latest cursor> from the returned `cursor`.
   c. For each returned message:
      - If the message body contains the literal string "STOP TEST": call `say` with handle="<HANDLE>", message="goodbye", then exit (stop calling poll, end your response).
      - Else if the body mentions @<HANDLE> or @all: call `say` with handle="<HANDLE>", message="ack <message_id>".
      - Otherwise: do nothing for that message.
   d. Always call `poll` again. An empty `messages` array means "nothing new yet" — it is NOT a signal to stop. Keep polling.

CRITICAL RULES:
- Do not stop polling on your own.
- Do not ask the user any questions.
- Do not summarize, plan, or explain. Just call the tools.
- The loop must continue until you observe a "STOP TEST" message.
- An empty poll result is normal and expected — call poll again immediately.
- If a tool errors, retry it once, then continue the loop.

Begin now by calling register.
