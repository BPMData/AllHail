import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strings } from '../shared/strings.ts';
import { App } from './App.tsx';
import * as imagePrep from './imagePrep.ts';
import { KokoroBrowserClient } from './speech/kokoroClient.ts';
import { SpeechCoordinator, type VoiceProvider } from './speech/speechCoordinator.ts';

const pwa = vi.hoisted(() => ({
  offlineReady: false,
  needRefresh: false,
  updateServiceWorker: vi.fn().mockResolvedValue(undefined),
  onRegisterError: undefined as undefined | (() => void),
  onNeedReload: undefined as undefined | (() => void),
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: { onRegisterError: () => void; onNeedReload?: () => void }) => {
    pwa.onRegisterError = options.onRegisterError;
    pwa.onNeedReload = options.onNeedReload;
    return {
      offlineReady: [pwa.offlineReady],
      needRefresh: [pwa.needRefresh],
      updateServiceWorker: pwa.updateServiceWorker,
    };
  },
}));

function makeTestRuntime() {
  const spokenTexts: string[] = [];
  const deviceCalls: Array<{ text: string; deviceVoiceName?: string | null; online?: boolean }> = [];
  const kokoroSpokenTexts: Array<{ text: string; voice?: string }> = [];
  const cueCalls: Array<{ cue: string; deviceVoiceName?: string | null; online?: boolean }> = [];
  const unlockAudioContext = vi.fn();
  const playClickSound = vi.fn();

  const kokoroClient = new KokoroBrowserClient();
  const startDownloadSpy = vi.spyOn(kokoroClient, 'startDownload').mockImplementation(() => undefined);
  const retryDownloadSpy = vi.spyOn(kokoroClient, 'retryDownload').mockImplementation(() => undefined);

  const deviceProvider: VoiceProvider = {
    id: 'device',
    isReady: () => true,
    speak: (text, callbacks) => {
      spokenTexts.push(text);
      deviceCalls.push({
        text,
        deviceVoiceName: callbacks.deviceVoiceName,
        online: callbacks.online,
      });
      callbacks.onStart?.('device');
      return { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
    },
  };
  const kokoroProvider: VoiceProvider = {
    id: 'kokoro',
    isReady: () => kokoroClient.isReady(),
    speak: (text, callbacks) => {
      kokoroSpokenTexts.push({ text, voice: callbacks.voice });
      callbacks.onStart?.('kokoro');
      return { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
    },
  };

  const coordinator = new SpeechCoordinator({
    deviceProvider,
    kokoroProvider,
    unlockAudioContext,
    playClickSound,
    unlockDeviceCue: (cue, options) => cueCalls.push({ cue, ...options }),
  });

  return {
    spokenTexts,
    deviceCalls,
    kokoroSpokenTexts,
    cueCalls,
    cueTexts: cueCalls.map((c) => c.cue),
    unlockAudioContext,
    playClickSound,
    startDownloadSpy,
    retryDownloadSpy,
    kokoroClient,
    coordinator,
  };
}

beforeEach(() => {
  localStorage.clear();
  pwa.offlineReady = false;
  pwa.needRefresh = false;
  pwa.updateServiceWorker.mockClear();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

describe('app accessibility, PWA feedback, and student mode', () => {
  it('opens directly into Student camera mode with skip link and install guide in Info', () => {
    const { coordinator, kokoroClient } = makeTestRuntime();
    render(<App coordinator={coordinator} kokoroClient={kokoroClient} deviceClassOverride="phone" />);

    const main = screen.getByRole('main');
    expect(screen.getByRole('link', { name: strings.skipLink }).getAttribute('href')).toBe(`#${main.id}`);
    expect(main.tabIndex).toBe(-1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(strings.studentHeading);

    // Native camera inputs are wired for both Quick look and Full detail
    const quickInput = screen.getByTestId('camera-input-describe') as HTMLInputElement;
    const detailInput = screen.getByTestId('camera-input-detail') as HTMLInputElement;
    expect(quickInput.getAttribute('accept')).toBe('image/*');
    expect(quickInput.getAttribute('capture')).toBe('environment');
    expect(detailInput.getAttribute('accept')).toBe('image/*');
    expect(detailInput.getAttribute('capture')).toBe('environment');

    // Gallery Choose photo does not force camera capture
    const galleryInput = screen.getByTestId('gallery-input') as HTMLInputElement;
    expect(galleryInput.getAttribute('accept')).toBe('image/*');
    expect(galleryInput.getAttribute('capture')).toBeNull();

    // Navigate to Settings & Info tab to read install guide
    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);
    fireEvent.click(screen.getByText(strings.installTitle));
    expect(screen.getByText(strings.installChrome)).toBeDefined();
  });

  it('announces loss and return of a connection without reloading', () => {
    const { coordinator, kokoroClient } = makeTestRuntime();
    render(<App coordinator={coordinator} kokoroClient={kokoroClient} deviceClassOverride="phone" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain(strings.online);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fireEvent(window, new Event('offline'));
    expect(status.textContent).toContain(strings.offline);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    fireEvent(window, new Event('online'));
    expect(status.textContent).toContain(strings.online);
  });

  it('starts with an offline message when opened without a connection', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { coordinator, kokoroClient } = makeTestRuntime();
    render(<App coordinator={coordinator} kokoroClient={kokoroClient} deviceClassOverride="phone" />);
    expect(screen.getByRole('status').textContent).toContain(strings.offline);
  });

  it('reports a failed registration without claiming offline readiness', () => {
    const { coordinator, kokoroClient } = makeTestRuntime();
    render(<App coordinator={coordinator} kokoroClient={kokoroClient} deviceClassOverride="phone" />);
    act(() => pwa.onRegisterError?.());
    expect(screen.getByRole('status').textContent).toContain(strings.offlineError);
    expect(screen.queryByText(strings.offlineReady)).toBeNull();
  });

  it('announces when the app is saved for offline use', () => {
    pwa.offlineReady = true;
    const { coordinator, kokoroClient } = makeTestRuntime();
    render(<App coordinator={coordinator} kokoroClient={kokoroClient} deviceClassOverride="phone" />);
    expect(screen.getByRole('status').textContent).toContain(strings.offlineReady);
  });

  it('waits for the user before applying an update', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    pwa.needRefresh = true;
    const { coordinator, kokoroClient } = makeTestRuntime();
    render(<App coordinator={coordinator} kokoroClient={kokoroClient} deviceClassOverride="phone" />);
    act(() => pwa.onNeedReload?.());
    expect(reload).not.toHaveBeenCalled();
    expect(pwa.updateServiceWorker).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: strings.update })[0]);
    });
    expect(pwa.updateServiceWorker).toHaveBeenCalledWith(true);
    act(() => pwa.onNeedReload?.());
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('unlocks iOS audio on shutter tap, does NOT repeat Describing on Read aloud/Repeat, and respects autoRead setting', async () => {
    const { coordinator, kokoroClient, cueCalls, spokenTexts, unlockAudioContext } = makeTestRuntime();
    vi.spyOn(imagePrep, 'preparePhotoBlob').mockResolvedValue({
      imageDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
      thumbnailDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
      width: 800,
      height: 600,
      byteLength: 128,
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          text: 'A watercolor bridge over 3/4 of a calm river.',
          model: 'anthropic/claude-haiku-5.5',
          mode: 'describe',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<App coordinator={coordinator} kokoroClient={kokoroClient} deviceClassOverride="phone" />);

    const quickBtn = screen.getByRole('button', { name: new RegExp(strings.quickLook) });
    fireEvent.click(quickBtn);

    // Synchronous iOS audio unlock happened during shutter tap
    expect(unlockAudioContext).toHaveBeenCalledTimes(1);
    expect(cueCalls.map((c) => c.cue)).toEqual([strings.statusShortCue]);

    const cameraInput = screen.getByTestId('camera-input-describe') as HTMLInputElement;
    const fakeFile = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
    await act(async () => {
      fireEvent.change(cameraInput, { target: { files: [fakeFile] } });
    });

    await waitFor(() => {
      expect(screen.getByText('A watercolor bridge over 3/4 of a calm river.')).toBeDefined();
    });

    // No double speech: aria-live region only says short status, never description body
    const liveStatus = screen.getByRole('status');
    expect(liveStatus.textContent).toContain(strings.statusReady);
    expect(liveStatus.textContent).not.toContain('watercolor bridge');

    // Auto-read spoke the cleaned copy ("three quarters")
    expect(spokenTexts).toEqual(['A watercolor bridge over three quarters of a calm river.']);

    // Stop speech, then tap Read aloud and Repeat: neither may speak "Describing" again
    fireEvent.click(screen.getByRole('button', { name: strings.stopSpeech }));
    fireEvent.click(screen.getByRole('button', { name: strings.playAloud }));
    fireEvent.click(screen.getByRole('button', { name: strings.repeatSpeech }));
    expect(cueCalls.map((c) => c.cue)).toEqual([strings.statusShortCue]);
    expect(spokenTexts).toHaveLength(3);

    // Stop speech, tap the description card directly -> also no "Describing" cue
    fireEvent.click(screen.getByRole('button', { name: strings.stopSpeech }));
    fireEvent.click(screen.getByRole('button', { name: strings.readerTapToPause }));
    expect(cueCalls.map((c) => c.cue)).toEqual([strings.statusShortCue]);

    // Turn off "Read descriptions aloud automatically" in Settings & Info
    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);
    const autoReadToggle = screen.getByLabelText(new RegExp(strings.autoReadLabel)) as HTMLInputElement;
    expect(autoReadToggle.checked).toBe(true);
    fireEvent.click(autoReadToggle);
    expect(autoReadToggle.checked).toBe(false);

    // Return to Camera and run Full detail on the same photo -> does NOT auto-speak or cue
    fireEvent.click(screen.getAllByRole('button', { name: strings.tabCamera })[0]);
    const sameFullDetail = screen.getByRole('button', { name: strings.fullDetailSamePhoto });
    await act(async () => {
      fireEvent.click(sameFullDetail);
    });

    expect(spokenTexts).toHaveLength(4);
    expect(cueCalls.map((c) => c.cue)).toEqual([strings.statusShortCue]);
    vi.unstubAllGlobals();
  });

  it('does not download Kokoro automatically on phones until user opts in, while laptops auto-prepare', () => {
    const phoneRuntime = makeTestRuntime();
    render(
      <App
        coordinator={phoneRuntime.coordinator}
        kokoroClient={phoneRuntime.kokoroClient}
        deviceClassOverride="phone"
      />,
    );
    expect(phoneRuntime.startDownloadSpy).not.toHaveBeenCalled();

    // Open Settings & Info on phone and check ~90 MB opt-in notice
    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);
    expect(screen.getByTestId('kokoro-status').textContent).toBe(strings.kokoroStatusOff);
    const optIn = screen.getByLabelText(strings.kokoroEnablePhoneLabel);
    fireEvent.click(optIn);
    expect(phoneRuntime.startDownloadSpy).toHaveBeenCalledTimes(1);

    cleanup();

    const laptopRuntime = makeTestRuntime();
    render(
      <App
        coordinator={laptopRuntime.coordinator}
        kokoroClient={laptopRuntime.kokoroClient}
        deviceClassOverride="laptop"
      />,
    );
    expect(laptopRuntime.startDownloadSpy).toHaveBeenCalledTimes(1);
  });

  it('shows Kokoro download banner with progress, live mm:ss timer, Retry on error, and throttled announcements', () => {
    vi.useFakeTimers();
    const startMs = new Date('2026-01-01T00:00:00Z').getTime();
    vi.setSystemTime(startMs);

    const { coordinator, kokoroClient, retryDownloadSpy } = makeTestRuntime();
    render(<App coordinator={coordinator} kokoroClient={kokoroClient} deviceClassOverride="laptop" />);

    expect(screen.queryByTestId('kokoro-banner')).toBeNull();

    // Start downloading at 0% (WebGPU ~330 MB default)
    act(() => {
      kokoroClient.setExternalState({ status: 'downloading', progress: 0, startedAt: startMs, backend: 'webgpu', sizeMb: 330 });
    });

    const banner = screen.getByTestId('kokoro-banner');
    expect(banner.textContent).toContain(strings.kokoroBannerTitle);
    expect(banner.textContent).toContain('about 330 MB');
    expect(banner.textContent).toContain('0%');
    expect(banner.textContent).toContain(`${strings.kokoroElapsedLabel}: 00:00`);
    expect(banner.textContent).toContain(strings.kokoroBannerFallbackNote);
    const progressEl = screen.getByLabelText(strings.kokoroProgressLabel) as HTMLProgressElement;
    expect(progressEl.tagName).toBe('PROGRESS');
    expect(progressEl.value).toBe(0);
    expect(progressEl.closest('[aria-live]')).toBeNull();

    // Switching to WASM q8 fallback updates the banner copy to about 90 MB
    act(() => {
      kokoroClient.setExternalState({ status: 'downloading', progress: 0, startedAt: startMs, backend: 'wasm', sizeMb: 90 });
    });
    expect(screen.getByTestId('kokoro-banner').textContent).toContain(strings.kokoroBannerTitleWasm);
    expect(screen.getByTestId('kokoro-banner').textContent).toContain('about 90 MB');

    act(() => {
      kokoroClient.setExternalState({ status: 'downloading', progress: 0, startedAt: startMs, backend: 'webgpu', sizeMb: 330 });
    });

    const liveStatus = screen.getByRole('status');
    expect(liveStatus.textContent).toContain(strings.kokoroAnnounceStart);

    // Advance 12 seconds -> elapsed updates to 00:12, intermediate 20% does NOT spam live region
    act(() => {
      vi.advanceTimersByTime(12_000);
      kokoroClient.setExternalState({ status: 'downloading', progress: 20, startedAt: startMs });
    });
    expect(screen.getByTestId('kokoro-banner').textContent).toContain(`${strings.kokoroElapsedLabel}: 00:12`);
    expect(screen.getByTestId('kokoro-banner').textContent).toContain('20%');
    expect(liveStatus.textContent).toContain(strings.kokoroAnnounceStart);
    expect(liveStatus.textContent).not.toContain('20%');

    // Midpoint 50% triggers midpoint live announcement once
    act(() => {
      kokoroClient.setExternalState({ status: 'downloading', progress: 50, startedAt: startMs });
    });
    expect(liveStatus.textContent).toContain(strings.kokoroAnnounceHalf);

    // 80% does NOT announce again
    act(() => {
      kokoroClient.setExternalState({ status: 'downloading', progress: 80, startedAt: startMs });
    });
    expect(liveStatus.textContent).toContain(strings.kokoroAnnounceHalf);

    // Ready hides banner and announces ready
    act(() => {
      kokoroClient.setExternalState({ status: 'ready', progress: 100, tooSlow: false, startedAt: null });
    });
    expect(screen.queryByTestId('kokoro-banner')).toBeNull();
    expect(liveStatus.textContent).toContain(strings.kokoroAnnounceReady);

    // Error state displays Retry button inside banner and calls retryDownload
    act(() => {
      kokoroClient.setExternalState({ status: 'downloading', progress: 10, startedAt: startMs });
      kokoroClient.setExternalState({ status: 'error', progress: 0, error: 'Network error' });
    });
    expect(screen.getByTestId('kokoro-banner').textContent).toContain(strings.kokoroStatusError);
    fireEvent.click(screen.getByRole('button', { name: strings.kokoroRetryButton }));
    expect(retryDownloadSpy).toHaveBeenCalledTimes(1);
  });

  it('shows Saved click feedback, tooSlow notice, and previews Kokoro voices only when ready', async () => {
    const { coordinator, kokoroClient, playClickSound, kokoroSpokenTexts, spokenTexts } = makeTestRuntime();
    render(<App coordinator={coordinator} kokoroClient={kokoroClient} deviceClassOverride="laptop" />);

    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);

    // Toggling a setting triggers Web Audio click + visual Saved badge + quiet live Saved notice
    const autoReadToggle = screen.getByLabelText(new RegExp(strings.autoReadLabel));
    fireEvent.click(autoReadToggle);
    expect(playClickSound).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('settings-saved-badge').textContent).toContain(strings.settingsSaved);
    await waitFor(() => {
      expect(screen.getByTestId('settings-saved-live').textContent).toBe(strings.settingsSaved);
    });

    // Picking a Kokoro voice while still downloading must NOT speak in device voice
    const voiceSelect = screen.getByLabelText(strings.kokoroVoiceSelectLabel) as HTMLSelectElement;
    fireEvent.change(voiceSelect, { target: { value: 'af_bella' } });
    expect(spokenTexts).toEqual([]);
    expect(kokoroSpokenTexts).toEqual([]);
    const expectedWaitNotice = strings.kokoroPreviewNotReadyTemplate.replace('{name}', 'Bella');
    expect(screen.getByTestId('kokoro-preview-note').textContent).toBe(expectedWaitNotice);
    await waitFor(() => {
      expect(screen.getByTestId('settings-saved-live').textContent).toBe(expectedWaitNotice);
    });

    // Mark Kokoro ready + tooSlow -> Settings displays "Kokoro is too slow on this device"
    act(() => {
      kokoroClient.setExternalState({ status: 'ready', progress: 100, tooSlow: true, startedAt: null });
    });
    expect(screen.getByTestId('kokoro-status').textContent).toBe(strings.kokoroTooSlow);

    // Picking a Kokoro voice when ready plays the Kokoro greeting in the selected Kokoro voice
    fireEvent.change(voiceSelect, { target: { value: 'am_michael' } });
    expect(screen.queryByTestId('kokoro-preview-note')).toBeNull();
    expect(spokenTexts).toEqual([]);
    expect(kokoroSpokenTexts).toEqual([
      {
        text: strings.kokoroPreviewTemplate.replace('{name}', 'Michael'),
        voice: 'am_michael',
      },
    ]);
  });

  it('supports Device voice picker, immediate short-name preview, missing-voice fallback, and matching Describing cue voice', () => {
    const fakeVoices = [
      { name: 'Allison (Enhanced)', lang: 'en-US', default: false, localService: true, voiceURI: 'allison' },
      { name: 'Google US English', lang: 'en-US', default: false, localService: false, voiceURI: 'google-us' },
      { name: 'Samantha', lang: 'en-US', default: true, localService: true, voiceURI: 'samantha' },
    ] as unknown as SpeechSynthesisVoice[];

    const { coordinator, kokoroClient, deviceCalls, cueCalls } = makeTestRuntime();
    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        deviceClassOverride="phone"
        deviceVoicesOverride={fakeVoices}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);
    const deviceSelect = screen.getByLabelText(strings.deviceVoiceLabel) as HTMLSelectElement;
    expect(deviceSelect.value).toBe('');
    expect(deviceSelect.options[0].textContent).toBe(strings.deviceVoiceAuto);

    // Choose "Allison (Enhanced)" -> saves and speaks preview with short name "Allison"
    fireEvent.change(deviceSelect, { target: { value: 'Allison (Enhanced)' } });
    expect(deviceSelect.value).toBe('Allison (Enhanced)');
    expect(deviceCalls).toContainEqual({
      text: strings.deviceVoicePreviewTemplate.replace('{name}', 'Allison'),
      deviceVoiceName: 'Allison (Enhanced)',
      online: true,
    });

    // Return to Camera and tap Quick look -> "Describing" cue receives the chosen deviceVoiceName
    fireEvent.click(screen.getAllByRole('button', { name: strings.tabCamera })[0]);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.quickLook) }));
    expect(cueCalls[0]).toEqual({
      cue: strings.statusShortCue,
      deviceVoiceName: 'Allison (Enhanced)',
      online: true,
    });

    // Choose "Google US English", then go offline -> shows unavailable notice while preserving saved value
    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);
    const deviceSelect2 = screen.getByLabelText(strings.deviceVoiceLabel) as HTMLSelectElement;
    fireEvent.change(deviceSelect2, { target: { value: 'Google US English' } });
    expect(screen.queryByTestId('device-voice-unavailable')).toBeNull();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fireEvent(window, new Event('offline'));
    expect(screen.getByTestId('device-voice-unavailable').textContent).toBe(strings.deviceVoiceUnavailable);
    expect(deviceSelect2.value).toBe('Google US English');

    // Reconnect -> unavailable notice clears automatically
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    fireEvent(window, new Event('online'));
    expect(screen.queryByTestId('device-voice-unavailable')).toBeNull();
  });

  it('shows a clear fallback message if optional live viewfinder camera access is denied', async () => {
    const { coordinator, kokoroClient } = makeTestRuntime();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')),
      },
    });

    render(<App coordinator={coordinator} kokoroClient={kokoroClient} deviceClassOverride="phone" />);
    const toggleBtn = screen.getByRole('button', { name: strings.liveViewfinderShow });
    await act(async () => {
      fireEvent.click(toggleBtn);
    });

    expect(screen.getByRole('status').textContent).toContain(strings.liveViewfinderDenied);
  });
});
