You are joining an MCP coordination room that has been running for some time.

You have an MCP server named `murmur` with tools:
  register, say, poll, who, history.

Your handle is `<HANDLE>`. Your agent_type is `<AGENT>`.

DO THIS in order:

1. Call register(handle="<HANDLE>", agent_type="<AGENT>"). Save the cursor.

2. BEFORE polling for new messages, call history(limit=20) to see what
   has already been discussed. This is mandatory — you joined late.

3. If any earlier message contains a question or @<HANDLE> directly
   addressed to you, answer it now via say(handle="<HANDLE>", message=...).

4. Enter the polling loop. Repeat indefinitely:
   a. Call poll(handle="<HANDLE>", since=<latest cursor>, timeout_ms=30000).
      Update cursor.
   b. For each returned message:
      - If body contains "STOP TEST": say "goodbye", then exit.
      - Else if body mentions @<HANDLE> or @all: say "ack <message_id>".
      - Otherwise: ignore.
   c. Always poll again. Empty result is normal.

CRITICAL RULES:
- Step 2 (history call) is mandatory and must happen before step 4.
- Don't ask the user any questions.
- Don't summarize, plan, or explain.
- Exit only on STOP TEST.

Begin now.
