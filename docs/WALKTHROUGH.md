# Design walkthrough

How each part works and why it was built that way. Read this alongside the code until you can explain every section without it; these are the things an interviewer will ask about.

## 1. The agent loop

File: `backend/app/agent/loop.py`

An LLM on its own can only produce text. An *agent* is a loop around it:

1. Send the conversation and a list of tool descriptions to the model.
2. If the model replies with text, that is the answer. Stop.
3. If it replies with tool calls, run them, append the results to the conversation, and go to 1.

That is the whole idea, and `run_agent` is about 100 lines. The decisions inside it:

**Tools run in parallel.** When the model asks for several tools in one step ("compare Mumbai and Delhi"), they run with `asyncio.gather`. Two weather lookups take as long as one.

**A tool failure is data, not an exception.** If a tool fails, the loop sends `{"error": "Couldn't find a place called 'Atlantis'."}` back to the model as that tool's result. The model then explains the problem in its own words. A crash inside a tool is caught by the registry and reduced to a generic message, so one bug can't take down a request or leak internals.

**There is a step limit.** After `MAX_AGENT_STEPS` rounds of tool calls (default 5), the next model call is made with *no tools offered*, which forces an answer. Without this a confused model could loop until the quota is gone.

**Retries are narrow.** A model call is retried only if (a) the error is a rate limit, outage or network failure, (b) nothing has been streamed to the user yet, (c) the wait the server asked for is under 8 seconds, and (d) fewer than 2 retries have happened. A wrong API key is never retried; it can't succeed.

**Text before a tool call is thrown away.** Some models write "Let me check that for you" and then call a tool. That text was already streamed, so the loop emits a `reset` event and the browser removes it.

**The loop has no dependencies on the web.** It takes a provider, a tool runner and a `sleep` function as arguments and yields plain events. The tests pass in a scripted fake model and a fake `sleep`, so every branch above is tested in milliseconds with no network.

Why not LangChain? For one loop and nine tools it would add a large dependency and hide the part most worth understanding. Writing it directly means there is nothing in the request path you can't explain.

## 2. The provider layer

Files: `backend/app/llm/`

Gemini and Groq have different wire formats. Gemini uses `contents` with `parts` and calls a tool call a `functionCall`. Groq uses the OpenAI format: `messages` with `tool_calls` whose arguments arrive as a JSON *string* split across many stream chunks.

`base.py` defines neutral types (`ChatMessage`, `ToolCall`, `TextDelta`, `TurnEnd`). Each provider converts to and from them. The agent loop only sees the neutral types, so adding a provider means writing one class and nothing else changes.

**Raw HTTP instead of SDKs.** Both providers are written against the REST APIs with `httpx`. That keeps dependencies small, makes the exact request visible, and lets tests replace the network with a fake transport and assert on the bytes sent.

**Thought signatures (Gemini).** Gemini 3 models attach an encrypted `thoughtSignature` to the first function call of each step and reject the follow-up request if it comes back missing or altered. The provider therefore stores the model's reply parts exactly as received (`ChatMessage.raw`) and sends them back untouched. The integration test server enforces this the same way the real API does.

**Errors are translated once.** Every failure becomes an `LLMError` with a `kind` (`auth`, `rate_limit`, `model`, `blocked`, `server`, `network`, `bad_request`) and a message that tells the user what to change, for example which variable in `.env`. Nothing above the provider parses HTTP status codes.

**Fallback with a rest period.** `FallbackProvider` tries providers in order. If Gemini is rate limited, Groq answers. The failed provider is then *rested* for as long as it asked (or 30 seconds), so the next few requests go straight to the one that works instead of paying for a doomed call first. This is a simple circuit breaker. It only switches before any text has streamed, so the user never sees half an answer from each.

**Switching provider mid-answer.** Because history is kept in neutral form, a conversation can move between providers between steps. Each provider rebuilds its own format from the neutral messages when the stored raw form came from someone else.

**Demo mode.** With no key, `DemoProvider` picks a tool from keywords and reads the tool's summary back. It exists so the whole app runs end to end the minute it is installed.

## 3. Tools

Files: `backend/app/tools/`

A tool is a dataclass: name, description, JSON-schema parameters, an async handler, a cache lifetime, and an optional function that fills in defaults from user preferences. The registry (`tools/__init__.py`) is the only way to run one.

**Two outputs per tool.** Each returns a `panel` (everything the screen needs: 7 forecast days, coordinates, links) and `data` (a trimmed version for the model). Sending the model only what it needs to write two sentences saves tokens on every call, which matters on free quotas.

**The model's arguments are not trusted.** `clean_args` drops undeclared keys and coerces types, because models do send `"3"` for an integer. Values that end up in URLs are validated (a GitHub repository must match `owner/name`; a username can't contain a slash).

**Caching with stale-on-error.** Results are cached in memory per tool and arguments. If a later call fails (rate limit, outage) and an older result exists, the older result is served and marked as cached. Free APIs fail often; this keeps the demo alive.

**Defaults are resolved before caching.** "The weather" with a saved city of Chennai and "the weather in Chennai" produce the same cache key.

**News parsing uses defusedxml.** RSS is XML from the internet. Python's standard parser is vulnerable to entity-expansion attacks; `defusedxml` rejects them. There is a test that feeds it one.

**Sample-data mode.** `offline.py` is a fake HTTP transport. With `OFFLINE_SAMPLE_DATA=true` the tools run their real code but the "network" answers from that file. It is for demos without internet, and it is how the test suite exercises tools without calling anyone.

## 4. Streaming

Files: `backend/app/main.py`, `frontend/src/lib/sse.ts`, `frontend/src/lib/api.ts`

Answers stream so the first word appears in well under a second instead of after the whole reply is generated.

The backend uses **server-sent events**: a long HTTP response made of `event:` and `data:` lines. It is one-directional, which is all a reply needs, and it works through ordinary proxies and free hosts. WebSockets would add connection management for no benefit here.

The browser's built-in `EventSource` can only make GET requests, and a question belongs in a POST body. So the frontend reads the response with `fetch` and a small parser. Network chunks can cut an event anywhere, so the parser buffers until it sees a blank line; a test replays the same stream at chunk sizes from 1 byte upward.

Text arrives many times a second. The frontend redraws at most once per animation frame.

## 5. Hand tracking

Files: `frontend/src/lib/gestures.ts`, `oneEuro.ts`, `interaction.ts`, `handTracker.ts`, `config/gestures.ts`

MediaPipe's hand landmarker runs in the browser as WebAssembly and returns 21 points per hand, each with x and y between 0 and 1 across the camera image. No video leaves the computer. Everything after that is this project's code, split in three so most of it can be tested without a camera.

**Gesture engine (`gestures.ts`): landmarks to cursor.**

- *Mirror and stretch.* x is flipped so moving right moves the cursor right. Only the centre of the camera frame is used, stretched to the whole screen, so the corners are reachable without the hand leaving the picture.
- *Scale-independent pinch.* The thumb-to-index distance is divided by the size of the hand in the frame. The same threshold then works whether the hand is near or far.
- *Hysteresis and debounce.* A pinch starts below one threshold and ends above a higher one, and each change must hold for two frames. Without this, a hand hovering near the threshold would click repeatedly.
- *Smoothing.* Landmarks jitter by a few pixels. A plain average would remove jitter but lag. The One Euro filter smooths heavily when the hand is slow, where jitter is visible, and lightly when it is fast, where lag is visible.
- *Click anchoring.* Closing the fingers moves the index fingertip, and with it the cursor, away from what you were pointing at. So a click lands where the cursor was 120 ms *before* the pinch was detected, taken from a short history buffer.
- *Dragging by the knuckle.* While pinching, the cursor follows the movement of the index knuckle from that anchor, because the fingertip is busy.
- *Hand identity.* MediaPipe returns hands in no fixed order. Each is matched to the slot whose wrist was nearest last frame, so two cursors never swap.
- *Losing the hand cancels.* If tracking drops during a pinch, the pinch ends as "cancelled" and nothing is clicked.

**Interaction layer (`interaction.ts`): cursor to actions.**

Every control in the app is a normal button or link. This layer asks the browser which element is under the cursor (`document.elementFromPoint`) and then hovers, clicks or drags it. That is why there is no separate gesture version of anything: a button added tomorrow works by hand automatically.

- Pinch on a button: it clicks if the pinch is released on the button or within 60 px of it. This is the same rule a mouse follows (press and release on the same control), with some room for a shaky hand. A button outside a panel is never turned into a drag.
- Pinch on a button inside a panel that travels more than 70 px: drag the panel instead.
- Point and hold: the cursor resting on a button for one second (within 48 px) clicks it, and a ring fills while it waits. It fires once and the cursor must leave before it can fire again. Links are excluded, because a browser blocks a new tab that doesn't come from a real click. This needs no pinch, so it is the fallback when pinch detection is unreliable in a given room or on a given hand.
- Pinch on empty space: spin the globe.
- Both hands pinching: scale by the ratio of the distance between them to the distance when it began.
- Open palm held 0.8 s over a panel: close it. The palm must be lowered before it can close another, so one gesture can't sweep the screen clear.

The layer talks to the page only through a small `InteractionHost` interface. Tests supply a fake page made of named rectangles.

**Tracker (`handTracker.ts`)** owns the webcam and the MediaPipe model, tries the GPU and falls back to the CPU, and draws the skeleton on the preview.

## 6. Voice

Files: `frontend/src/lib/speech.ts`, `voiceCommands.ts`, `assistant.ts`

Speech recognition and synthesis are the browser's built-in Web Speech API: free, nothing to install, but recognition exists only in Chromium browsers.

- **Interface commands never reach the model.** "Close that" is matched by a regular expression in the browser, so it is instant and costs no quota. A phrase only counts when the *whole* utterance matches: "close that" is a command, "close that chapter of history for me" is a question.
- **It doesn't listen to itself.** Recognition is paused while the assistant speaks.
- **Chrome stops listening after silence**, so the recogniser restarts itself until told to stop.
- **Noise filter.** In hands-free mode a single stray word or a low-confidence result is ignored.
- **Long replies are spoken in sentence-sized pieces**, because some browsers cut off long utterances. Code blocks are not read aloud.

## 7. The interface

- **Panels are HTML, the globe is WebGL.** Text in HTML stays sharp, links and selection work, and the hand layer can hit-test it. The globe is the one thing that benefits from 3D.
- **The globe is drawn from data.** Coastlines come from Natural Earth (the `world-atlas` package), converted to line segments on a sphere at load. Latitude and longitude map to 3D points in `geo.ts`, with a test that checks the rotation used to bring a city to face the viewer.
- **Layout.** One panel sits either side of the globe on a laptop, two rows on a tall window. A new answer replaces the oldest unpinned panel. Narrow screens stack panels in a column.
- **Safe rendering of model output.** Answers are Markdown. The renderer builds React elements and never sets raw HTML, so nothing the model writes can inject markup. Links are limited to http and https. A test feeds it script tags.
- **No accounts.** Each browser generates a random id once and sends it with every request; the backend scopes conversations and the activity log to it. A test checks that one browser can't read, continue or delete another's conversation.

## 8. Testing strategy

| Layer | How it is tested | What that proves |
|---|---|---|
| Tools | Fake HTTP transport with responses in each API's format | Parsing, defaults, error messages, caching |
| Providers | Fake transport, asserting on request bodies | Wire format, stream assembly, error mapping |
| Providers + loop | `tests/fake_llm.py` over real sockets | Real streaming, signature echo, retries, fallback |
| Agent loop | Scripted fake model | Every branch: parallel calls, limits, retries, resets |
| API | FastAPI test client, in-memory database | Routes, persistence, isolation between browsers, rate limiting |
| Gestures | Hands built from numbers | Cursor mapping, pinch timing, smoothing, two hands |
| Interaction | Fake page | Click vs drag, zoom, palm-dismiss |
| Voice, parsing, layout | Plain unit tests | Command grammar, stream parser, Markdown, placement |

The pattern throughout: put the logic in code with no I/O, and pass the I/O in. That is what makes hand tracking testable without a camera and an agent testable without a model.

## 9. Known limits, and what you would do next

Be ready to say these before you are asked.

- **Cache and rate limiter are in memory.** Fine for one small server; several servers would need Redis.
- **No accounts.** The browser id is not authentication. Adding login would mean replacing `client_id` with a user id.
- **Follow-up suggestions are rules, not generated.** Cheap and instant, but not tailored.
- **History is replayed as text notes**, not as real tool messages. Cheaper and provider-independent, but the model can't re-read old raw tool output.
- **Gestures depend on lighting** and on thresholds that suit most hands, not all.
- **Voice input is Chromium-only** and needs the network.
- **Google News RSS is unofficial as an API.** A keyed news API would be the production choice.
- **Tables are created at start-up.** A schema that changes over time would need migrations (Alembic).

## 10. Questions to practise

1. Walk me through what happens between the user speaking and the answer appearing.
2. What is tool calling? How does the model "call" a function?
3. How do you stop the agent looping forever or burning quota?
4. What happens when a tool fails? When the LLM is rate limited?
5. Why server-sent events and not WebSockets?
6. How would you add a new tool? A new LLM provider?
7. How do you test code that depends on an LLM and a webcam?
8. Why is the pinch threshold a ratio? What is hysteresis and why is it there?
9. What does the One Euro filter do that a moving average doesn't?
10. How is user data kept separate with no login? What is weak about that?
11. Where are the API keys, and why can't the browser see them?
12. What would break first with 1,000 users, and how would you fix it?
