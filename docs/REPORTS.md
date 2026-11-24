# Problem reports: setup

The **Something not working?** button at the top of every AllHail screen walks someone through four short steps: what went wrong, what happened (all optional), whether they want a reply, and a check of exactly what will be sent. Nothing is sent until they press **Send report**.

## How a report travels

1. The page sends the report to AllHail's own server, `POST /api/report`. That address is always reachable when AllHail is, so school networks that block Google scripts don't matter.
2. The server checks it (known categories and ticks only, safe diagnostics only, text trimmed), limits each address to 5 reports an hour, and passes it on with a shared secret to the **relay**: a small Google script ([`tools/report-relay.gs`](../tools/report-relay.gs)) that runs under the shared reports Gmail account, **overboard.reporting@gmail.com**. It is a separate script from OverBoard's relay, in the same Google account.
3. The relay:
   - opens a GitHub issue in BPMData/allhail labeled **problem-report**, from the **public part only**: the category, what they ticked, the AllHail version, browser and system, and feature and voice status;
   - emails the **whole report** to the reports inbox, with the subject starting **AllHail problem report:** so it is easy to tell apart from OverBoard's. The person's own words and email are only in this email, never in the issue. Press **Reply** to answer them;
   - if they gave an email: sends them a thank-you, and remembers their address (privately, in the script's settings) for one follow-up when the issue is closed as completed.

If anything fails, or the device is offline, the page offers **Copy report**, **Download report** and **Email the report**, all addressed to the same inbox.

**Never sent:** photos, descriptions, saved history, the name of the chosen device voice, or anything typed elsewhere in AllHail. The "last app message" is only included when it is one of AllHail's own fixed messages.

**When you fix a reported problem:** put `Fixes #12` in the pull request. Merging it closes the issue as completed, and the next daily check emails that person once, saying a fix is out and how to get it. An issue closed as **not planned** sends nothing.

This setup is done once and takes about 15 minutes. Until it's done, Send report shows the copy/download/email fallback, so nothing is lost.

## 1. Make a GitHub key that can only open issues

1. On GitHub, go to **Settings ▸ Developer settings ▸ Personal access tokens ▸ Fine-grained tokens ▸ Generate new token** ([direct link](https://github.com/settings/personal-access-tokens/new)).
2. **Token name:** `AllHail reports`. **Expiration:** the longest it offers. Put a reminder in your calendar a week before it runs out.
3. **Repository access:** *Only select repositories* ▸ **allhail**.
4. **Permissions ▸ Repository permissions ▸ Issues:** *Read and write*. Leave everything else as it is.
5. **Generate token** and copy it (it starts with `github_pat_`). Don't paste it anywhere except step 2.4.
6. In the allhail repository, go to **Issues ▸ Labels ▸ New label** and add one called `problem-report`.

## 2. Make the Google script

Sign in to Google as **overboard.reporting@gmail.com** (a private/incognito window avoids mixing up accounts).

1. Go to [script.google.com](https://script.google.com) ▸ **New project**. Rename it (top left) to `AllHail reports`.
2. Delete what's in `Code.gs`, then paste in all of [`tools/report-relay.gs`](../tools/report-relay.gs). Press **Save**.
3. Make a secret: any long random string, for example from running `node -e "console.log(crypto.randomUUID() + crypto.randomUUID())"`. Keep it for step 4.
4. Click **Project Settings** (the gear) ▸ **Script properties** ▸ **Add script property**. Add these, then **Save script properties**:
   - `GITHUB_TOKEN`: the token from step 1.5
   - `GITHUB_REPO`: `BPMData/allhail`
   - `RELAY_SECRET`: the secret from step 2.3
   - Skip `NOTIFY_EMAIL`. Without it, each report is emailed to the reports inbox itself.
5. Back in the **Editor**, choose **checkSetup** in the function menu and press **▶ Run**. Google asks for permission: choose the reports account, then **Advanced ▸ Go to AllHail reports (unsafe)** ▸ **Allow**. ("Unsafe" only means Google hasn't reviewed your own script.) The log should say the token works and a test email was sent.
6. Choose **installDailyCheck** and press **▶ Run**, so the fix follow-up emails are checked once a day.

## 3. Put it online

1. **Deploy ▸ New deployment** ▸ gear next to *Select type* ▸ **Web app**.
2. **Description:** `v1`. **Execute as:** *Me*. **Who has access:** *Anyone*. (The secret is what stops strangers using it.)
3. **Deploy**, then copy the **Web app URL** (it ends in `/exec`). Opening it in a browser should show `{"ok":true,"hello":"AllHail report relay"}`.

## 4. Tell the AllHail server about it

Set two variables on the `allhail` Cloud Run service, the same way `OPENROUTER_API_KEY` is set. The deploy workflow leaves them alone, so this is done once:

```
gcloud run services update allhail --region us-east1 --project loyal-rookery-403218 \
  --update-env-vars REPORT_RELAY_URL=https://script.google.com/macros/s/…/exec,REPORT_RELAY_SECRET=the-secret-from-2.3
```

(Or in the Cloud console: **Cloud Run ▸ allhail ▸ Edit & deploy new revision ▸ Variables & secrets**.)

Then send yourself a test report from the live app: you should get the email, a `problem-report` issue, and, if you typed your address, a thank-you.

For local testing, put the same two lines in `.env`.

## Changing the script later

Edit, save, then **Deploy ▸ Manage deployments ▸ ✏️ ▸ Version: New version ▸ Deploy**. This keeps the same URL. (A *New deployment* gets a new URL, which would then need updating in step 4.)

## Good to know

- **Limits.** The server allows 5 reports an hour from one address. The relay allows 20 an hour and 40 a day in all, 25 thank-yous a day, and one thank-you per email address a week. OverBoard's relay runs in the same Gmail account with its own limits; together they stay under Gmail's ~100 emails a day. To change a limit, edit the numbers at the top of the script.
- **Robots.** The page has a hidden box that people never see or hear. Reports with it filled in are dropped. The relay refuses anything without the secret.
- **Addresses** are kept only in the script's settings (`contact:12` and so on) until the issue is closed, or a year at most. Delete one there to stop its follow-up.
- **When the token expires,** issues stop being made but reports still arrive by email, each saying why the issue failed. Make a new token (step 1) and replace `GITHUB_TOKEN`.
- **Tests.** `tests/reportRelay.test.ts` runs the real relay script against fake Google services in CI, and `server/report.test.ts` checks the server route. Neither sends real email or opens real issues.
