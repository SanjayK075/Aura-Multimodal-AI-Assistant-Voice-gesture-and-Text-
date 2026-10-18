# Putting it online for free

The result is two public URLs: a static site for the frontend and a small server for the backend, plus a hosted database. Nothing here needs a paid plan.

Free plans change. The steps below describe how these hosts worked when this was written; if a screen looks different, the settings to enter are the same. This guide has not been run end to end from this project, so treat the first deployment as part of the work.

```
Browser  -->  Frontend (static files: Vercel, Netlify or Cloudflare Pages)
   |
   +------->  Backend (Docker container: Render)  -->  Postgres (Neon or Supabase)
```

## Before you start

1. Put the project on GitHub. From the project folder:

   ```
   git init
   git add .
   git commit -m "Aura: voice and gesture controlled AI assistant"
   ```

   Then create an empty repository on github.com and follow its "push an existing repository" commands.

2. Check that `backend/.env` is **not** in the commit: `git status` must not list it. The included `.gitignore` already excludes it. Your API keys must never be pushed.

## 1. Database

On a free host the backend's disk is wiped on every restart, so the default SQLite file would lose all history. Use a hosted Postgres instead.

1. Create a free Postgres database at [Neon](https://neon.tech/) or [Supabase](https://supabase.com/).
2. Copy its connection string. It looks like `postgresql://user:password@host/dbname?sslmode=require`.

The backend accepts that string as it is and creates its tables on first start.

## 2. Backend on Render

Render's free web service needs no card. It sleeps after 15 minutes without traffic and takes up to a minute to wake.

1. At [render.com](https://render.com/), choose **New, Blueprint** and select your repository. Render reads `render.yaml` from the project root. (Or choose **New, Web Service**, set the root directory to `backend` and the runtime to Docker.)
2. Enter the values it asks for:

   | Variable | Value |
   |---|---|
   | `GEMINI_API_KEY` | your Gemini key |
   | `GROQ_API_KEY` | your Groq key (optional, enables fallback) |
   | `GITHUB_TOKEN` | optional; a token with no scopes raises GitHub's limit |
   | `DATABASE_URL` | the Postgres connection string from step 1 |
   | `CORS_ORIGINS` | leave as `http://localhost:5173` for now |

3. Deploy. When it finishes, open `https://<your-service>.onrender.com/api/health`. It should show `{"status":"ok"}`.
4. Open `/api/config` on the same address and check `provider` is `gemini` or `groq`, not `demo`.

## 3. Frontend on Vercel

1. At [vercel.com](https://vercel.com/), choose **Add New, Project** and import the repository.
2. Set **Root Directory** to `frontend`. Vercel detects Vite; the build command is `npm run build` and the output directory is `dist`.
3. Add an environment variable: `VITE_API_URL` = your Render address, for example `https://aura-backend.onrender.com` (no trailing slash).
4. Deploy and note the site's address.

Netlify and Cloudflare Pages work the same way: base directory `frontend`, build command `npm run build`, publish directory `dist`, and the same `VITE_API_URL` variable.

`VITE_API_URL` is read at build time. If you change it, redeploy the frontend.

## 4. Allow the frontend to call the backend

Browsers block a site from calling another site unless that site allows it (CORS).

1. In Render, set `CORS_ORIGINS` to your frontend's address, for example `https://aura-yourname.vercel.app`. Several addresses can be separated by commas.
2. Save. Render restarts the service.

## 5. Try it

Open the frontend address in Chrome. If the backend was asleep the top bar says "Connecting to the server" for up to a minute, then "Ready". Ask a question, then turn on the camera and microphone. Both need HTTPS, which these hosts provide.

## Things to know

- **Wake it before a demo.** Open the site a minute or two before you show it to anyone.
- **Your quota is public.** Anyone with the link can ask questions that spend your free LLM quota. The backend limits each browser to `RATE_LIMIT_PER_MINUTE` requests (default 20); lower it for a public link. Because there are no accounts the limit can be evaded, so use free-tier keys only and never a key attached to billing.
- **The cache and rate limiter live in memory**, so they reset when the service restarts.
- **Hand-tracking files.** `npm install` copies MediaPipe's WebAssembly runtime into `frontend/public/mediapipe`, and the build publishes it with the site. The model itself is fetched from Google by each visitor's browser unless you run `npm run fetch-model` and commit `frontend/public/models`.
- **Updating.** Push to GitHub; both hosts rebuild automatically.

## If something goes wrong

| Symptom | Fix |
|---|---|
| Site loads but stays on "Connecting to the server" | `VITE_API_URL` is wrong or missing. Open the browser's developer tools, Network tab, and see where `/api/config` is being sent. |
| Console shows a CORS error | `CORS_ORIGINS` on the backend doesn't exactly match the site's address (check `https://` and no trailing slash). |
| Backend deploy fails at start | Read Render's log. A bad `DATABASE_URL` or `LLM_PROVIDER` is reported there in plain words. |
| History disappears | `DATABASE_URL` isn't set, so it is using a SQLite file on a disk that gets wiped. |
| Camera or microphone unavailable | The page isn't on HTTPS, or permission was denied in the browser. |
