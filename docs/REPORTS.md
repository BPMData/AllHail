# Problem reports

The **Something not working?** button at the top of every AllHail screen walks someone through four short steps: what went wrong, what happened (all optional), whether they want an email when it’s fixed, and a check of exactly what will be sent. Nothing is sent until they press **Send report**.

## How a report travels

1. The page sends the report to AllHail's own server, `POST /api/report`. That address is always reachable when AllHail is, so school networks that block Google scripts don't matter.
2. The server checks it (known categories and ticks only, safe diagnostics only, text trimmed) and limits each address to 5 reports an hour.
3. The server writes two things ([`server/reportMessage.ts`](../server/reportMessage.ts)):
   - a **public GitHub issue**, labeled **problem-report**, from the **public part only**: the category, what they ticked, the AllHail version, browser and system, and feature and voice status;
   - a **private email** with the whole report, the subject starting **[AllHail]**. The person's own words and email are only in this email, never in the issue.
4. It hands both, with AllHail's shared secret, to the **shared reports relay**: OverBoard's Google Apps Script ([`tools/report-relay.gs` in BPMData/OverBoard](https://github.com/BPMData/OverBoard/blob/main/tools/report-relay.gs)), which runs under the shared reports Gmail account, **overboard.reporting@gmail.com**. OverBoard, AllAboard, AllHail and OverHeard all use this one relay. It opens the issue in BPMData/AllHail and emails the reports inbox.

If anything fails, or the device is offline, the page offers **Copy report**, **Download report** and **Email the report**, all addressed to the same inbox.

**Never sent:** photos, descriptions, saved history, the name of the chosen device voice, or anything typed elsewhere in AllHail. The "last app message" is only included when it is one of AllHail's own fixed messages.

**One email to the person, only if they gave an address.** There's no thank-you email: the app shows "Thank you. Your report was sent." once the relay has the report. When the issue is **closed as completed**, the shared relay sends them one "here's what we changed" email (a short paragraph from your comments and pull request titles, then how to reload AllHail), and nothing else. An issue closed as not planned or as a duplicate sends nothing.

## Settings

The server needs two settings. Without them, **Send report** shows the copy/download/email fallback, so nothing is lost.

| Setting               | What it is                                                                                     | In production                                    |
| --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `REPORT_RELAY_URL`    | the shared relay's Web app address (ends in `/exec`)                                           | Secret Manager secret `allhail-report-relay-url`    |
| `REPORT_RELAY_SECRET` | AllHail's shared secret; the relay keeps the same value as its `ALLHAIL_TOKEN` script property | Secret Manager secret `allhail-report-relay-secret` |

The deploy workflow attaches both to the `allhail` Cloud Run service with `--set-secrets` on every deploy. The service runs as `allhail-run`, which may read only these two secrets. Nothing is pasted into the Cloud Run console or kept in GitHub.

To change one, add a new version of the secret in Secret Manager; the next deploy picks it up. If you change the secret, change `ALLHAIL_TOKEN` in the relay's script properties to match.

For local testing, put both in `.env` (see `.env.example`).

## Good to know

- **Limits.** The server allows 5 reports an hour from one address. The shared relay allows 20 reports an hour and 40 a day in all, across every app that uses it, so it stays well under Gmail's ~100 emails a day.
- **Robots.** The page has a hidden box that people never see or hear. Reports with it filled in are dropped. The relay refuses anything without the secret.
- **When the relay's GitHub token expires,** issues stop being made but reports still arrive by email, each saying why the issue failed.
- **Tests.** `server/reportMessage.test.ts` checks that nothing private reaches the public issue, and `server/report.test.ts` checks the server route. Neither sends real email or opens real issues.
