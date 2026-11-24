import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_FIELDS } from '../shared/report.ts';
import { strings } from '../shared/strings.ts';
import { collectDiagnostics, describeBrowser, type ReportContext } from './reportDiagnostics.ts';
import { DEFAULT_SETTINGS } from './settings.ts';

const context: ReportContext = {
  deviceClass: 'phone',
  online: true,
  offlineReady: true,
  updateWaiting: false,
  settings: { ...DEFAULT_SETTINGS, deviceVoiceName: 'Samantha (Enhanced)' },
  deviceVoiceCount: 3,
  deviceVoiceMissing: false,
  activeVoice: 'device',
  lastVoiceUsed: 'device',
  speaking: false,
  kokoroState: { status: 'idle', progress: 0, tooSlow: false, startedAt: null } as ReportContext['kokoroState'],
  piperState: { status: 'idle', progress: 0, tooSlow: false, startedAt: null, sizeMb: 60 } as ReportContext['piperState'],
  descriptionMode: 'detail',
  lastStatus: strings.statusReady,
};

describe('problem report diagnostics', () => {
  it('collects only the allowed app, browser and feature facts', async () => {
    const diagnostics = await collectDiagnostics(context);
    for (const key of Object.keys(diagnostics)) expect(DIAGNOSTIC_FIELDS).toHaveProperty(key);
    expect(diagnostics).toMatchObject({ deviceClass: 'phone', deviceVoiceChosen: true, descriptionMode: 'detail', lastStatus: strings.statusReady });
    expect(typeof diagnostics.appVersion).toBe('string');
    // The chosen voice's name is not sent, only that one was chosen.
    expect(JSON.stringify(diagnostics)).not.toContain('Samantha');
  });

  it('never passes on a status message that isn’t the app’s own words', async () => {
    const diagnostics = await collectDiagnostics({ ...context, lastStatus: 'A worksheet with Jamie Lee’s grades' });
    expect(diagnostics.lastStatus).toBe(strings.reportOtherMessage);
    const error = await collectDiagnostics({ ...context, lastStatus: `${strings.statusErrorPrefix} ${strings.errDescribeTimeout}` });
    expect(error.lastStatus).toBe(`${strings.statusErrorPrefix} ${strings.errDescribeTimeout}`);
  });

  it('names common browsers and systems', () => {
    expect(describeBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'))
      .toEqual({ browser: 'Safari 18.1', os: 'iOS 18.1' });
    expect(describeBrowser('Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'))
      .toEqual({ browser: 'Chrome 131', os: 'Android 15' });
    expect(describeBrowser('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'))
      .toEqual({ browser: 'Chrome 131', os: 'ChromeOS' });
  });
});
