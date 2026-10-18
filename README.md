# Aura

An AI assistant that runs in the browser and is controlled by voice, hand gestures or a mouse. You ask a question; an LLM agent decides which real API to call, fetches live data, and answers aloud while the result opens as a floating panel beside a 3D globe.

It is a full-stack project: a React and three.js frontend, a FastAPI backend with a tool-calling agent loop, two interchangeable LLM providers, seven external data sources, a database, tests and an evaluation script. Everything runs on free tiers.

## What it does

- **Answers anything.** General questions go straight to the model. Questions that need live data make the agent call a tool first.
- **Uses real services.** Weather (Open-Meteo), GitHub, news (Google News), Wikipedia, NASA's picture of the day, upcoming rocket launches (Launch Library 2) and the live position of the International Space Station.
- **Three ways to control it, freely mixed.** Speak, type, click, or pinch in the air. Every button works with all of them.
- **Shows its work.** The activity log lists every tool the agent called, with arguments, result and timing.
- **Keeps working when a free quota runs out.** With both a Gemini and a Groq key set, it switches provider automatically.

## What you need

- Windows, macOS or Linux
- [Python](https://www.python.org/downloads/) 3.11 or newer (tested on 3.13). On Windows, tick **Add python.exe to PATH** in the installer.
- [Node.js](https://nodejs.org/) 22 LTS or newer
- Chrome or Edge, a webcam and a microphone
- A free API key from [Google AI Studio](https://aistudio.google.com/apikey) or [Groq](https://console.groq.com/keys). Without one the app still runs in demo mode, where it can fetch live data but can't answer general questions.

## Set up

### Windows, the short way

1. Double-click `setup.bat` and wait for it to finish.
2. Open `backend\.env` in Notepad and paste your key after `GEMINI_API_KEY=` or `GROQ_API_KEY=`. Save.
3. Double-click `start.bat`. Two windows open (backend and frontend) and the app opens at http://localhost:5173.

### By hand (any system)

Backend, in one terminal:

```
cd backend
python -m venv .venv
.venv\Scripts\activate            (macOS/Linux: source .venv/bin/activate)
pip install -r requirements-dev.txt
copy .env.example .env            (macOS/Linux: cp .env.example .env)
```

Edit `backend/.env` and add your key, then:

```
uvicorn app.main:app --reload --port 8000
```

Frontend, in a second terminal:

```
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 in Chrome.

### Check the setup

With the backend's virtual environment active:

```
cd backend
python -m app.doctor
```

This makes one real tool-calling round trip with each model you have a key for, and calls every data source once. Each line says `[ OK ]` or `[FAIL]` with the reason. If a model name has been retired it lists the ones your key can use; put one in `.env` as `GEMINI_MODEL` or `GROQ_MODEL`. Run this first whenever something stops working.

## Using it

Allow the camera and microphone when Chrome asks. The camera button in the top bar turns hand control on; the microphone button turns listening on.

| To do this | Voice | Hands | Mouse |
|---|---|---|---|
| Ask a question | Say it | Pinch the mic button, then say it | Type it and press Enter |
| Run a quick action | "Show the weather", "Open the GitHub panel" | Pinch the button, or rest the cursor on it for a second | Click it |
| Move a panel | "Move it left" | Pinch on it and move | Drag its title bar |
| Resize a panel | "Make it bigger" | Pinch with both hands, pull apart | Drag its corner, or scroll over the title |
| Close a panel | "Close that" | Hold an open palm over it | Click the close button |
| Page through a panel | "Next", "Go back" | Pinch the arrows | Click the arrows, or scroll |
| Keep a panel | "Pin that" | Pinch the pin | Click the pin |
| Clear the screen | "Clear all" | Pinch the clear button | Click it |
| Spin the globe | | Pinch empty space and move | Drag the background |
| Stop a reply | "Stop" or "Enough", even while Aura is talking | Pinch the stop button | Click it, or press Esc |

New answers take the place of old ones beside the globe. Pin a panel to keep it.

The Help button in the top bar shows this list inside the app. Set your city and GitHub username in Settings so "the weather" and "my repositories" work.

### Getting hand control to behave

- Sit so your hand is inside the dashed box in the camera preview. That box maps to the whole screen.
- The strip under the camera preview shows what the pinch detector sees, for example `open 0.62 · click below 0.30`. Pinch your fingers and it should change to `PINCH` with a lower number. If it never does, set Settings → **Pinch sensitivity** to Easy. If it says PINCH while your hand is relaxed, choose Firm.
- A click lands when you release the pinch on the button or just beside it, so a small wobble doesn't matter.
- **Point and hold** is the easy alternative: rest the cursor on a button for a second, a ring fills, and it clicks. No pinch needed. Turn it off in Settings if it fires when you don't want it to.
- Light should fall on your hand. A bright window behind you makes tracking drop out.
- The first time you turn the camera on, the browser downloads the hand-tracking model (about 8 MB) from Google. To serve it from the app instead, run `npm run fetch-model` in `frontend` once.
- Hand tracking runs entirely in the browser; camera video is never uploaded. MediaPipe, the library that does the tracking, sends anonymous usage statistics to Google ([its privacy notice](https://goo.gle/mediapipe-privacy)).
- Settings has **Reach** (how far your hand must move to cross the screen) and a switch for the open-palm gesture.
- Every threshold is in one commented file: `frontend/src/config/gestures.ts`. If clicks trigger too easily lower `pinchOn`; if they are hard to trigger raise it. If the cursor shakes lower `smoothingMinCutoff`; if it lags raise `smoothingBeta`.

Voice input uses the browser's speech recognition, which exists in Chrome and Edge and needs an internet connection. In other browsers the app still works by typing.

## Tests

```
cd backend
python -m pytest            159 tests: tools, both LLM providers, the agent loop, the API

cd frontend
npm test                    162 tests: gestures, pointer logic, voice commands, parsing, layout
npm run build               type-checks and builds
```

No test needs an API key or the network. The backend tests answer every outside call from a fake transport or from `tests/fake_llm.py`, a small server that speaks Gemini's and Groq's wire formats over real HTTP. The gesture tests feed hand positions built from numbers, so no camera is involved.

## Measuring it

`eval/run_eval.py` sends 30 fixed questions through the running backend and reports task success, tool-choice accuracy and response times. Start the backend with a real key, then:

```
cd backend
python ..\eval\run_eval.py
```

It takes about five minutes (it pauses between questions to stay inside free rate limits) and writes `eval/results/latest.md`. Those are your numbers for a resume line such as: *"...X% task success on a 30-question test set, Y s median response."*

## Project layout

```
backend/
  app/
    main.py            HTTP routes; streams replies as server-sent events
    config.py          every setting, read from .env
    agent/loop.py      the agent loop: model call, run tools, repeat
    agent/prompts.py   the system prompt
    llm/               provider layer: gemini.py, openai_compat.py (Groq), demo.py, fallback
    tools/             one file per data source, plus the registry
    db.py              conversations, messages and the tool-call log (SQLite or Postgres)
    offline.py         sample responses for running without internet
    doctor.py          setup checker
  tests/
frontend/
  src/
    lib/gestures.ts      hand landmarks -> cursor, pinch, open palm
    lib/interaction.ts   makes a hand behave like a pointer
    lib/handTracker.ts   webcam and MediaPipe
    lib/assistant.ts     sends questions, applies the streamed reply, speech, voice commands
    components/          the globe (Scene.tsx), panels, dock, drawers
    store/               application state (Zustand) and panel layout
    config/gestures.ts   every hand-tracking threshold
eval/                    the 30-question evaluation
docs/                    architecture, design walkthrough, deployment
```

## More documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the parts fit together, the API, the data model
- [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md): why each part is built the way it is
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): putting it online for free

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Top bar says "Server not responding" | The backend isn't running, or crashed on start. Look at its terminal window. A wrong `LLM_PROVIDER` or a missing key for the chosen provider is reported there. |
| "Demo mode" badge | No API key was found. Check `backend/.env` (not `.env.example`) and restart the backend. |
| "...has no model called..." | The provider retired that model. Run `python -m app.doctor` and set `GEMINI_MODEL` or `GROQ_MODEL` to one it lists. |
| "...free quota is used up" | You hit the free rate limit. Wait, or add the other provider's key so it can fall back. |
| Camera or microphone "blocked" | Click the icon at the left of the address bar and allow them, then switch the camera or mic on again. |
| Pinching doesn't click anything | Watch the readout under the camera preview (see above). Try Pinch sensitivity: Easy, or use point and hold: rest the cursor on the button for a second. |
| Aura keeps talking when I say stop | Say just "stop" or "enough", on its own. Hands-free mode must be on (Settings → Microphone → Stays on); in "One question per press" mode the mic is off while Aura talks, so press the stop button or Esc. |
| "Open the GitHub panel" opens Settings | The GitHub button needs your username. Add it in Settings. |
| Hand cursor jumps or vanishes | Improve the light on your hand and keep it inside the dashed box. See the tuning notes above. |
| It hears itself or random speech | Use Settings, Microphone, "One question per press". |
| A link pinched by hand doesn't open | The browser blocked the pop-up. Allow pop-ups for the site, or click links with the mouse. |
| GitHub says it is rate limiting | Unauthenticated GitHub allows 60 requests an hour. Add a token as `GITHUB_TOKEN` in `.env`. |
| NASA picture fails | The shared `DEMO_KEY` allows 30 requests an hour. Get a free key at api.nasa.gov and set `NASA_API_KEY`. |
| Port already in use | Another program is on 8000 or 5173. Close it, or change the port in the command and in `frontend/vite.config.ts`. |

## Credits

Weather data by [Open-Meteo](https://open-meteo.com/). Launch data by [The Space Devs](https://thespacedevs.com/). ISS position by [Where the ISS at?](https://wheretheiss.at/). Article summaries from [Wikipedia](https://www.wikipedia.org/). Astronomy pictures from [NASA APOD](https://apod.nasa.gov/). Hand tracking by [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker). Coastlines from [Natural Earth](https://www.naturalearthdata.com/) via world-atlas.
