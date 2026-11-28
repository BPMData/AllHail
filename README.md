# AllHail

AllHail is an installable web app for blind and low-vision students and their teachers. It turns photos into speech, alongside OverBoard, AllAboard and OverHeard. Documents and typed text come next (see [PLAN.md](PLAN.md)).

**Open it:** [bpmdata.github.io/allhail](https://bpmdata.github.io/allhail). That short link sends you to the app's Cloud Run address.

- **Camera capture.** The **Quick look** and **Full detail** buttons open the camera, or take a frame from an optional live viewfinder. You can also choose a photo you already have. The phone vibrates when the photo is taken and again when the description is ready.
- **Two description modes:**
  - **Quick look:** a short overview (60–150 words) to get your bearings.
  - **Full detail:** everything a sighted classmate could study. It reads all the text, handwriting, circled answers and grades, then describes the whole image area by area.
- **Speech that starts by itself**, using an ordered fallback list of voices that run on the device:
  - the device voice (`speechSynthesis`)
  - Kokoro, which runs in the browser. It needs WebGPU and is a one-time download of about 330 MB.
  - Piper, which runs in the browser and is a smaller one-time download.

  Phones start with the device voice, and laptops with Kokoro, then Piper. Settings can change the order. If a voice fails or stays silent for 4 seconds, the next one takes over before speaking starts. A job never changes voice halfway through. The Google Cloud and Lemonfox cloud voices are planned but not built yet.
- **Reading controls.** Tap the description to pause or resume. There are also Repeat, Stop and speed buttons. You can edit or copy the text, and download an MP3 made with Kokoro or Piper; device voices can't be saved as files.
- **Works offline.** The app shell, the history and the Kokoro, Piper and device voices all work without the internet. With no connection, the app says plainly that new photos can't be described right now.
- **History** of the last 50 descriptions, saved on the device in IndexedDB. Each can be replayed, opened, downloaded as an MP3 or deleted.
- **Screen-reader ready.** Every control has a label, and status changes are announced ("Describing photo", "Description ready"). It is built for VoiceOver and TalkBack; checks on real devices still need a human.
- **Private.** There are no accounts, and nothing leaves the device except the description request. Before upload, each photo is turned upright, shrunk to at most 1,568 px and redrawn so no GPS or camera details are sent. If that step fails, the photo isn't sent.

## Run it locally

Use **Node 24 LTS** (`nvm use` if you use nvm). Node 22.18 or later also supports the server's native TypeScript execution.

```bash
npm ci
cp .env.example .env
npm run dev
```

`npm ci` installs the exact versions in `package-lock.json`. Use `npm install` only when you add or update a dependency, and commit the updated lock file with it.

Open `http://localhost:3000`. To describe photos, put an OpenRouter key in `.env` as `OPENROUTER_API_KEY`. Without one, `POST /api/describe` replies "Photo descriptions are not configured on the server yet.", and everything else still works. The development server updates the browser when you edit files. Its service worker is disabled so old cached files don't hide your edits.

To try the installable, offline version, build it and start the production server:

```bash
npm run build
NODE_ENV=production npm start
```

The server serves the built app only when `NODE_ENV=production`; otherwise it runs the development server.

`PORT` defaults to `3000`, and `HOST` to `0.0.0.0`. Production runs `node server.ts` directly, with no TypeScript loader. `GET /api/health` checks that the server is up. `/api/describe` allows 20 requests per minute from each address. Deployment must use HTTPS for installation and offline support; localhost is fine for development. A phone visiting a laptop's plain HTTP network address can't use its service worker.

### Deploying

Every push to `main` runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). It runs the checks below, then deploys the `allhail` Cloud Run service with `gcloud run deploy --source .` on port 3000.

- The workflow logs in to Google Cloud with Workload Identity Federation: GitHub gives the job a short-lived token, and Google accepts it only from this repository's `main` branch (provider `allhail` in the `github` pool, acting as `github-deployer`). No key is stored in GitHub.
- Before uploading, `scripts/check-upload.sh` stops the deploy if a `gha-creds-*.json` credentials file would be uploaded or `package-lock.json` would be missing. After deploying, `scripts/check-deploy.sh` checks for a new ready revision labelled with the commit and that the live address answers.
- The service runs as its own account, `allhail-run`, which can read only AllHail's own secrets.
- `REPORT_RELAY_URL` and `REPORT_RELAY_SECRET` (for problem reports, see [docs/REPORTS.md](docs/REPORTS.md)) come from Secret Manager: every deploy attaches `allhail-report-relay-url` and `allhail-report-relay-secret` with `--set-secrets`. Nothing is pasted into the Cloud Run console.
- `OPENROUTER_API_KEY` comes from Secret Manager too: every deploy attaches `allhail-openrouter-api-key` with `--set-secrets`. To change the key, add a new version of that secret (`gcloud secrets versions add allhail-openrouter-api-key --data-file=-`); the next deploy picks it up. The deploy sets only `NODE_ENV=production` besides the secrets and leaves the other service variables alone.
- The deploy keeps `--max-instances 1`. The rate limit is kept in memory, so more instances would multiply how much of the key one person can use.
- `https://bpmdata.github.io/allhail` is a short link that redirects to the service's Cloud Run URL. The redirect isn't in this repo. Because the browser ends up on the Cloud Run address, the installed app, its offline files and its history all belong to that address, not to github.io.

## Check changes

```bash
npm run typecheck
npm run build
npm test
node -e "import('./server.ts').then(() => console.log('OK'))"
npm run smoke
npx playwright install chromium
npm run test:pwa
```

GitHub Actions runs these checks with Node 24, in this order, on every pull request.

- `npm run build` also runs `check:ort`, which makes sure exactly one ONNX runtime ships and reports Piper's download size.
- Unit tests mock the service worker, OpenRouter and the voices.
- The smoke test starts the production Express app on a temporary port. It checks the routes, cache headers, the manifest, icon sizes and the service worker.
- Playwright checks Chrome install eligibility and reopening offline, on desktop and on an emulated Android phone. It also checks that API replies are never cached.

None of these checks call real AI or speech services or use real photos. Test output stays out of git.

## Install and check offline on a real device

1. Open [bpmdata.github.io/allhail](https://bpmdata.github.io/allhail) in Chrome on a laptop or Android phone, and let it redirect to the Cloud Run address. Wait for **App saved for offline use**.
2. On a laptop, choose Chrome's install icon in the address bar. On Android, use **Install app** or **Add to Home screen** from Chrome's menu.
3. Describe a photo or two so the History has something in it. If you want an offline voice, let Kokoro or Piper finish downloading.
4. Close AllHail, disconnect from the internet, and open it again from its installed icon. Check:
   - the Camera, History and Settings & Info tabs open
   - an offline announcement is made
   - saved descriptions still play
5. Reconnect and check that the connection announcement changes. Try keyboard navigation and large text, plus VoiceOver or TalkBack.

On iPhone or iPad, use Safari's Share menu and **Add to Home Screen**. Installing on physical devices and checking with screen readers still need a human; browser emulation doesn't replace them.

The service worker precaches the built app files, including local icons and styles. Piper's runtime files (`/ort/`, `/piper/`) are cached the first time they're used. Kokoro's model is stored by the browser when it downloads. API routes are excluded from offline navigation, and photos and API results are never cached. New versions offer an **Update AllHail** button, so a reload doesn't interrupt your work.

## Simple mode for a student

For a student who is blind or has low vision, a teacher or aide can turn on simple mode at the bottom of Settings & Info. It shows one very large Take photo button, the description, Repeat and Pause, and nothing else to swipe through. It stays on after the app is closed or updated. Leaving it takes the PIN set up with it, or two deliberate presses if no PIN was set. For a full lock, also use Guided Access on iPhone or screen pinning on Android.

## Where things live

- `src/`: React app and styles (React 19, Tailwind 4).
- `src/styles.css`: the look, a flat printed page with paper, ink and thick rules. Maroon is only for the thing to press. It also holds the four text sizes, dark mode, and the rules for the phone's own text size, contrast and motion settings.
- `src/components/CaptureView.tsx`: student camera mode.
- `src/components/HistoryView.tsx`: description history.
- `src/components/SimpleModeView.tsx` and `SimpleModeSetup.tsx`: simple mode and where it is set up and locked.
- `src/components/InfoSettingsView.tsx`: settings (voice order, Kokoro and Piper downloads), install help, privacy and credits.
- `src/imagePrep.ts`: turning each photo upright, shrinking it and stripping its metadata before upload.
- `src/historyStore.ts`: IndexedDB history.
- `src/speech/`: the on-device speech pipeline: Kokoro, Piper, device voices, the coordinator that picks a voice, and MP3 export.
- `server/describe.ts`: photo description endpoint with model fallback chains.
- `src/components/ReportView.tsx`, `shared/report.ts`, `server/report.ts` and `server/reportMessage.ts`: the "Something not working?" problem report. Setup is in [docs/REPORTS.md](docs/REPORTS.md).
- `server/visionConfig.ts`: the model chains for each button, timeouts and rate limits.
- `shared/prompts.ts`: the v5 description prompts.
- `shared/speechCleaner.ts`: tidies text for the voice (fractions to words, no markdown).
- `shared/strings.ts`: all visible text, including HTML and manifest wording.
- `server.ts`: Express server and development Vite middleware.
- `vite.config.ts`: build, install manifest and offline cache rules.
- `public/icons/`: original SVG and install icons. Regenerate the PNGs with `node scripts/generate-icons.mjs` after installing Playwright's Chromium.
- `tools/vision-bakeoff/`: the preserved, human-run model and prompt tests. They are separate from app checks; see their [README](tools/vision-bakeoff/README.md).

Read [AGENTS.md](AGENTS.md) and [PLAN.md](PLAN.md) before changing the app. Keep API keys on the server; never use a `VITE_` variable for a secret. Personal photos, `.env` files and bake-off results stay out of git.

## Recover the Streamlit version

The old Streamlit app lives in the archived [`BPMData/tts_st`](https://github.com/BPMData/tts_st) repository, under the `streamlit-final` tag. This repo doesn't have that tag. To get a copy in its own folder:

```bash
git clone --branch streamlit-final https://github.com/BPMData/tts_st.git ../allhail-streamlit
```

The original Python files, Streamlit configuration and requirements are all there. No personal photos or secrets are included.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: submitting a pull request gives
the project's owner the right to relicense your contribution, including under commercial terms.

## Licence and credits

AllHail is free software under the GNU General Public License v3.0 or later ([`LICENSE`](LICENSE)). It ships eSpeak NG, which is GPL. [`CREDITS.md`](CREDITS.md) lists every voice, model and library with its licence. It's free and non-commercial; don't sell it while it uses the Piper voice.

Created by a high school computer science teacher to help students with vision impairments.
