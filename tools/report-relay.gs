/* AllHail problem reports: the relay.
   Runs as a Google Apps Script web app under the shared reports Gmail account, overboard.reporting@gmail.com
   (setup: docs/REPORTS.md). It is a separate script from OverBoard's relay, in the same Google account.

   The AllHail server (POST /api/report) checks each report and passes it here with a shared secret.
   This script:
     1. opens a GitHub issue in BPMData/allhail labeled "problem-report", from the report's public part only
        (what went wrong, what the person ticked, and app/browser/feature facts),
     2. emails the whole report to the reports inbox, with the person's own words and email address.
        Those never go into the public issue. Press Reply on the email to answer them, and
     3. if they gave an email: sends them a thank-you, and remembers their address (only here, in this script's
        settings) so checkForFixes() can tell them once when the issue is closed as fixed.

   Limits, so a robot can't flood the issues or use this Gmail account to email strangers: 20 reports an hour,
   40 a day, 25 thank-yous a day, and one thank-you per address a week. OverBoard's relay runs in the same
   account with its own limits; together they stay under Gmail's ~100 emails a day.

   Script properties (Project Settings ▸ Script properties):
     GITHUB_TOKEN   a fine-grained GitHub token: the allhail repository only, Issues: read and write
     GITHUB_REPO    BPMData/allhail
     RELAY_SECRET   a long random string; the same value goes in the server's REPORT_RELAY_SECRET
     NOTIFY_EMAIL   (optional) where to email reports; leave it out to use this Google account's own inbox
*/

var APP = 'AllHail';
var KIND = 'problem-report';
var LABEL = 'problem-report';
var MAX_CHARS = 100000;
var MAX_PER_HOUR = 20;
var MAX_PER_DAY = 40;
var MAX_THANKS_PER_DAY = 25;
var THANK_AGAIN_DAYS = 7;
var APP_URL = 'https://bpmdata.github.io/allhail';
var EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

var CATEGORIES = {
  camera: 'Taking or choosing a photo',
  descriptions: 'Photo descriptions',
  speech: 'Speech, voices or MP3',
  offline: 'Offline use, installing or updating',
  history: 'Saved history',
  access: 'Screen reader, keyboard or text size',
  other: 'Something else',
};

function doPost(e) {
  try {
    var text = (e && e.postData && e.postData.contents) || '';
    if (text.length > MAX_CHARS) return reply({ ok: false, error: 'too big' });
    var r = JSON.parse(text);
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('RELAY_SECRET');
    if (!secret || r.secret !== secret) return reply({ ok: false, error: 'not allowed' });
    delete r.secret;
    if (!r || r.app !== APP || r.kind !== KIND || !r['public'] || !CATEGORIES[r['public'].category]) {
      return reply({ ok: false, error: 'not a report' });
    }
    if (!underLimit()) return reply({ ok: false, error: 'busy' });

    var priv = r['private'] || {};
    var issue = null,
      issueError = '';
    try {
      issue = openIssue(r, props);
    } catch (err) {
      issueError = String(err).slice(0, 500);
    }
    emailReport(r, priv, issue, issueError, props);
    var email = String(priv.email || '').trim();
    var thanked = false;
    if (EMAIL_RE.test(email)) {
      if (mayThank(email)) {
        try {
          thankYou(email, issue);
          thanked = true;
        } catch (err) {
          Logger.log('thank-you failed: ' + err);
        }
      }
      if (issue)
        props.setProperty(
          'contact:' + issue.number,
          JSON.stringify({ email: email, category: r['public'].category, at: Date.now() })
        );
    }
    return reply({
      ok: true,
      issue: issue ? issue.number : null,
      url: issue ? issue.html_url : null,
      thanked: thanked,
    });
  } catch (err) {
    return reply({ ok: false, error: String(err).slice(0, 200) });
  }
}

function doGet() {
  return reply({ ok: true, hello: 'AllHail report relay' });
}

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function underLimit() {
  return withLock(function () {
    var cache = CacheService.getScriptCache(),
      key = 'sent-' + Math.floor(Date.now() / 3600000);
    var n = Number(cache.get(key) || 0);
    if (n >= MAX_PER_HOUR) return false;
    if (!countToday('reports', MAX_PER_DAY)) return false;
    cache.put(key, String(n + 1), 3700);
    return true;
  });
}

/* Daily counts live in Script properties as day:2026-11-24 = {"reports":3,"thanks":1}. Call inside withLock. */
function countToday(kind, max) {
  var props = PropertiesService.getScriptProperties(),
    key = 'day:' + today(),
    c = {};
  try {
    c = JSON.parse(props.getProperty(key) || '{}');
  } catch (e) {}
  if ((c[kind] || 0) >= max) return false;
  c[kind] = (c[kind] || 0) + 1;
  props.setProperty(key, JSON.stringify(c));
  return true;
}

function today() {
  return Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
}

function mayThank(email) {
  var key = 'thanked:' + emailHash(email);
  return withLock(function () {
    var props = PropertiesService.getScriptProperties();
    if (Date.now() - Number(props.getProperty(key) || 0) < THANK_AGAIN_DAYS * 864e5) return false;
    if (!countToday('thanks', MAX_THANKS_PER_DAY)) return false;
    props.setProperty(key, String(Date.now()));
    return true;
  });
}

function emailHash(email) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email.toLowerCase())
    .map(function (b) {
      return ('0' + (b & 255).toString(16)).slice(-2);
    })
    .join('')
    .slice(0, 32);
}

/* ---------- plain words ---------- */
/* anything going into the public issue is kept plain (no links, @mentions, HTML or markdown tricks) */
function clean(s, n) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[<>@`*_\[\]|#\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n || 160);
}
function category(r) {
  return CATEGORIES[r['public'].category] || 'Something else';
}
function system(r) {
  var d = r['public'].diagnostics || {};
  return clean(d.os || 'unknown system', 60) + ' · ' + clean(d.browser || 'unknown browser', 60);
}
function summary(r) {
  var p = r['public'],
    d = p.diagnostics || {};
  var lines = [
    '**What went wrong:** ' + category(r),
    '**What fits:** ' +
      ((p.symptoms || [])
        .map(function (x) {
          return clean(x, 40);
        })
        .join(', ') || 'nothing ticked'),
    '**AllHail:** ' + clean(d.appVersion || '?', 20) + ' (built ' + clean(d.appBuilt || '?', 20) + ')',
    '**System:** ' + system(r) + ' · ' + clean(d.deviceClass || '?', 20),
    '',
    '| Detail | Value |',
    '|---|---|',
  ];
  Object.keys(d).forEach(function (k) {
    if (k === 'userAgent') return;
    lines.push('| ' + clean(k, 40) + ' | ' + clean(d[k], 160) + ' |');
  });
  if (d.userAgent) lines.push('', 'Browser details: ' + clean(d.userAgent, 400));
  return lines.join('\n');
}

/* ---------- GitHub ---------- */
function openIssue(r, props) {
  var token = props.getProperty('GITHUB_TOKEN'),
    repo = props.getProperty('GITHUB_REPO') || 'BPMData/allhail';
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  var title = ('Problem report: ' + category(r) + ' · ' + system(r)).slice(0, 200);
  var body =
    summary(r) +
    '\n\n<sub>Sent from AllHail\'s "Something not working?" page. The person\'s own words and email, if any, went to the private reports inbox only.</sub>';
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/issues', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify({ title: title, body: body, labels: [LABEL] }),
  });
  if (res.getResponseCode() !== 201)
    throw new Error('GitHub said ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
}

/* ---------- email ---------- */
function emailReport(r, priv, issue, issueError, props) {
  var to = props.getProperty('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail();
  var email = String(priv.email || '').trim(),
    okEmail = EMAIL_RE.test(email);
  var text = [
    issue
      ? 'GitHub issue: ' + issue.html_url
      : 'The GitHub issue could not be made: ' + (issueError || 'unknown reason'),
    '',
    'Their email: ' + (email || '(none given)') + (okEmail ? '  (Reply to this message to answer them.)' : ''),
    'What happened: ' + (priv.details ? '\n' + String(priv.details).slice(0, 4000) : '(not given)'),
    'How to make it happen again: ' + (priv.steps ? '\n' + String(priv.steps).slice(0, 4000) : '(not given)'),
    '',
    summary(r).replace(/\*\*/g, ''),
    '',
    'The full report is attached.',
  ].join('\n');
  var opts = {
    to: to,
    subject: 'AllHail problem report: ' + category(r) + ' · ' + system(r),
    body: text,
    attachments: [Utilities.newBlob(JSON.stringify(r, null, 1), 'application/json', 'AllHail-problem-report.json')],
  };
  if (okEmail) opts.replyTo = email;
  MailApp.sendEmail(opts);
}

/* ---------- emails to the person ---------- */
function thankYou(email, issue) {
  MailApp.sendEmail({
    to: email,
    name: 'AllHail',
    subject: 'We got your AllHail report',
    body: [
      'Hi,',
      '',
      'Thank you for telling us what went wrong in AllHail. Your report arrived safely.',
      '',
      'What happens next: we will look into it. When there is a fix, you will get one more email from this address saying how to get it. Nothing else will be sent to you.',
      issue ? '\nYou can follow your report here (no sign-in needed): ' + issue.html_url + '\n' : '',
      'Thanks again,',
      'AllHail',
    ].join('\n'),
  });
}

/* Run once a day (installDailyCheck). Tells each person whose report was closed as fixed, then forgets them. */
function checkForFixes() {
  var props = PropertiesService.getScriptProperties(),
    all = props.getProperties();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('day:') === 0) {
      if (key !== 'day:' + today()) props.deleteProperty(key);
      return;
    }
    if (key.indexOf('thanked:') === 0) {
      if (Date.now() - Number(all[key]) >= THANK_AGAIN_DAYS * 864e5) props.deleteProperty(key);
      return;
    }
    if (key.indexOf('contact:') !== 0) return;
    var n = key.slice(8),
      contact;
    try {
      contact = JSON.parse(all[key]);
    } catch (e) {
      props.deleteProperty(key);
      return;
    }
    try {
      var issue = github('/issues/' + n);
      if (issue.state !== 'closed') {
        if (Date.now() - contact.at > 365 * 864e5) props.deleteProperty(key);
        return;
      }
      if (issue.state_reason === 'completed') sendFollowUp(contact.email, issue);
      props.deleteProperty(key);
    } catch (err) {
      Logger.log('report #' + n + ': ' + err);
    }
  });
}

function sendFollowUp(email, issue) {
  MailApp.sendEmail({
    to: email,
    name: 'AllHail',
    subject: 'AllHail: a fix for the problem you reported',
    body: [
      'Hi,',
      '',
      'A while ago you sent a report from AllHail\'s "Something not working?" page. Thank you again.',
      '',
      'We have made a change to AllHail that should help with the problem you reported.',
      '',
      'How to make sure you have the new version:',
      '1. Open AllHail: ' + APP_URL,
      '2. If it says "A new version of AllHail is ready", choose Update AllHail.',
      '3. If you installed AllHail as an app, close it fully and open it again.',
      '',
      'If it still does not work, please send another report from "Something not working?". Every report helps.',
      '',
      'Your report: ' + issue.html_url,
      'This is the last email you will get about this report.',
      '',
      'AllHail',
    ].join('\n'),
  });
}

function github(path) {
  var props = PropertiesService.getScriptProperties();
  var repo = props.getProperty('GITHUB_REPO') || 'BPMData/allhail';
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + path, {
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + props.getProperty('GITHUB_TOKEN'),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.getResponseCode() !== 200) throw new Error('GitHub said ' + res.getResponseCode() + ' for ' + path);
  return JSON.parse(res.getContentText());
}

/* ---------- run these once from the editor (▶ Run) ---------- */
function installDailyCheck() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkForFixes') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkForFixes').timeBased().everyDays(1).atHour(15).create();
  Logger.log('checkForFixes will run once a day.');
}

function checkSetup() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('GITHUB_TOKEN'),
    repo = props.getProperty('GITHUB_REPO') || 'BPMData/allhail';
  if (!token) throw new Error('Add GITHUB_TOKEN under Project Settings ▸ Script properties first.');
  if (!props.getProperty('RELAY_SECRET'))
    throw new Error('Add RELAY_SECRET under Project Settings ▸ Script properties first.');
  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo, {
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
  });
  if (res.getResponseCode() !== 200)
    throw new Error('GitHub token problem (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  Logger.log('GitHub token works for ' + repo);
  var to = props.getProperty('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(
    to,
    'AllHail relay: setup check',
    'If you can read this, the AllHail relay can email you. Next: Deploy ▸ New deployment (see docs/REPORTS.md).'
  );
  Logger.log('Sent a test email to ' + to + '. All set.');
}
