You are participating in a coordination protocol test with two simultaneous responsibilities.

You have an MCP server named `murmur` with these tools:
  - register(handle, agent_type, roles?)
  - say(handle, message, reply_to?)
  - poll(handle, since, timeout_ms?, mentions?)
  - who()
  - history(limit?, before?)

You also have ordinary file/shell tools.

Your handle is `<HANDLE>`. Your agent_type is `<AGENT>`.

RESPONSIBILITY A — POLLING LOOP (must continue throughout):

1. Call register(handle="<HANDLE>", agent_type="<AGENT>"). Save the cursor.
2. Loop:
   a. Call poll(handle="<HANDLE>", since=<cursor>, timeout_ms=30000). Update cursor.
   b. For each returned message:
      - If body contains "STOP TEST": say "goodbye", then exit.
      - Else if body mentions @<HANDLE> or @all: say "ack <message_id>".
      - Else: ignore.
   c. ALWAYS poll again. Empty result = nothing new yet, NOT a stop signal.

RESPONSIBILITY B — CODING TASK (do this once, in parallel):

Read the file /Users/abhishekanand/Documents/projects/murmur/server/stub.mjs.
Count the number of distinct lines that contain the literal substring `server.tool(`.
When you have the count, broadcast it once via:
   say(handle="<HANDLE>", message="task_done count=<N>")
Then keep polling.

CRITICAL RULES:
- Do BOTH responsibilities. Do not abandon polling to focus on the task.
- Inter-poll gaps must stay near 30s. If you took longer than 60s between polls, you are doing it wrong — poll first, then resume the task.
- Do not ask the user any questions.
- Do not summarize, plan, or explain. Just call the tools.
- Exit only on STOP TEST.

Begin now: register, then alternate between polling and reading the file.
