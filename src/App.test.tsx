import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strings } from '../shared/strings.ts';
import { App } from './App.tsx';
import * as historyStore from './historyStore.ts';
import * as imagePrep from './imagePrep.ts';
import { loadSettings } from './settings.ts';
import { KokoroBrowserClient } from './speech/kokoroClient.ts';
import { PIPER_TOTAL_SIZE_MB } from './speech/piperAssets.ts';
import { PiperBrowserClient } from './speech/piperClient.ts';
import { buildTestWavArrayBuffer } from './speech/piperLoader.test.ts';
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
  const piperSpokenTexts: string[] = [];
  const cueCalls: Array<{ cue: string; deviceVoiceName?: string | null; online?: boolean }> = [];
  const unlockAudioContext = vi.fn();
  const playClickSound = vi.fn();

  const kokoroClient = new KokoroBrowserClient();
  const startDownloadSpy = vi.spyOn(kokoroClient, 'startDownload').mockImplementation(() => undefined);
  const retryDownloadSpy = vi.spyOn(kokoroClient, 'retryDownload').mockImplementation(() => undefined);

  const piperClient = new PiperBrowserClient();
  const piperStartDownloadSpy = vi.spyOn(piperClient, 'startDownload').mockImplementation(() => undefined);
  const piperRetryDownloadSpy = vi.spyOn(piperClient, 'retryDownload').mockImplementation(() => undefined);

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
    isBusy: () => kokoroClient.isBusy(),
    speak: (text, callbacks) => {
      kokoroSpokenTexts.push({ text, voice: callbacks.voice });
      callbacks.onStart?.('kokoro');
      return { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
    },
  };
  const piperProvider: VoiceProvider = {
    id: 'piper',
    isReady: () => piperClient.isReady(),
    isBusy: () => piperClient.isBusy(),
    speak: (text, callbacks) => {
      piperSpokenTexts.push(text);
      callbacks.onStart?.('piper');
      return { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
    },
  };

  const coordinator = new SpeechCoordinator({
    deviceProvider,
    kokoroProvider,
    piperProvider,
    unlockAudioContext,
    playClickSound,
    unlockDeviceCue: (cue, options) => cueCalls.push({ cue, ...options }),
  });

  return {
    spokenTexts,
    deviceCalls,
    kokoroSpokenTexts,
    piperSpokenTexts,
    cueCalls,
    cueTexts: cueCalls.map((c) => c.cue),
    unlockAudioContext,
    playClickSound,
    startDownloadSpy,
    retryDownloadSpy,
    piperStartDownloadSpy,
    piperRetryDownloadSpy,
    kokoroClient,
    piperClient,
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
  it('opens directly into Student camera mode with skip link and install/credits info in Info', () => {
    const { coordinator, kokoroClient, piperClient } = makeTestRuntime();
    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        piperClient={piperClient}
        deviceClassOverride="phone"
      />,
    );

    const main = screen.getByRole('main');
    expect(screen.getByRole('link', { name: strings.skipLink }).getAttribute('href')).toBe(`#${main.id}`);
    expect(main.tabIndex).toBe(-1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(strings.studentHeading);

    const quickInput = screen.getByTestId('camera-input-describe') as HTMLInputElement;
    const detailInput = screen.getByTestId('camera-input-detail') as HTMLInputElement;
    expect(quickInput.getAttribute('accept')).toBe('image/*');
    expect(quickInput.getAttribute('capture')).toBe('environment');
    expect(detailInput.getAttribute('accept')).toBe('image/*');
    expect(detailInput.getAttribute('capture')).toBe('environment');

    const galleryInput = screen.getByTestId('gallery-input') as HTMLInputElement;
    expect(galleryInput.getAttribute('accept')).toBe('image/*');
    expect(galleryInput.getAttribute('capture')).toBeNull();

    // Navigate to Settings & Info tab to check install guide, active voice, and required CC BY-NC-SA attribution
    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);
    expect(screen.getByTestId('active-voice-status').textContent).toBe(
      `${strings.activeVoicePrefix}: ${strings.activeVoiceDevice}`,
    );
    fireEvent.click(screen.getByText(strings.installTitle));
    expect(screen.getByText(strings.installChrome)).toBeDefined();
    expect(screen.getByTestId('piper-attribution').textContent).toBe(strings.piperAttribution);
    expect(screen.getByRole('link', { name: strings.creditsLinkLabel }).getAttribute('href')).toBe(
      '/CREDITS.md',
    );
  });

  it('announces loss and return of a connection without reloading', () => {
    const { coordinator, kokoroClient, piperClient } = makeTestRuntime();
    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        piperClient={piperClient}
        deviceClassOverride="phone"
      />,
    );
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
    const { coordinator, kokoroClient, piperClient } = makeTestRuntime();
    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        piperClient={piperClient}
        deviceClassOverride="phone"
      />,
    );
    expect(screen.getByRole('status').textContent).toContain(strings.offline);
  });

  it('reports a failed registration without claiming offline readiness', () => {
    const { coordinator, kokoroClient, piperClient } = makeTestRuntime();
    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        piperClient={piperClient}
        deviceClassOverride="phone"
      />,
    );
    act(() => pwa.onRegisterError?.());
    expect(screen.getByRole('status').textContent).toContain(strings.offlineError);
    expect(screen.queryByText(strings.offlineReady)).toBeNull();
  });

  it('announces when the app is saved for offline use', () => {
    pwa.offlineReady = true;
    const { coordinator, kokoroClient, piperClient } = makeTestRuntime();
    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        piperClient={piperClient}
        deviceClassOverride="phone"
      />,
    );
    expect(screen.getByRole('status').textContent).toContain(strings.offlineReady);
  });

  it('waits for the user before applying an update', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    pwa.needRefresh = true;
    const { coordinator, kokoroClient, piperClient } = makeTestRuntime();
    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        piperClient={piperClient}
        deviceClassOverride="phone"
      />,
    );
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
    const { coordinator, kokoroClient, piperClient, cueCalls, spokenTexts, unlockAudioContext } =
      makeTestRuntime();
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

    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        piperClient={piperClient}
        deviceClassOverride="phone"
      />,
    );

    const quickBtn = screen.getByRole('button', { name: new RegExp(strings.quickLook) });
    fireEvent.click(quickBtn);

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

    const liveStatus = screen.getByRole('status');
    expect(liveStatus.textContent).toContain(strings.statusReady);
    expect(liveStatus.textContent).not.toContain('watercolor bridge');

    expect(spokenTexts).toEqual(['A watercolor bridge over three quarters of a calm river.']);

    fireEvent.click(screen.getByRole('button', { name: strings.stopSpeech }));
    fireEvent.click(screen.getByRole('button', { name: strings.playAloud }));
    fireEvent.click(screen.getByRole('button', { name: strings.repeatSpeech }));
    expect(cueCalls.map((c) => c.cue)).toEqual([strings.statusShortCue]);
    expect(spokenTexts).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: strings.stopSpeech }));
    fireEvent.click(screen.getByRole('button', { name: strings.readerTapToPause }));
    expect(cueCalls.map((c) => c.cue)).toEqual([strings.statusShortCue]);

    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);
    const autoReadToggle = screen.getByLabelText(new RegExp(strings.autoReadLabel)) as HTMLInputElement;
    expect(autoReadToggle.checked).toBe(true);
    fireEvent.click(autoReadToggle);
    expect(autoReadToggle.checked).toBe(false);

    fireEvent.click(screen.getAllByRole('button', { name: strings.tabCamera })[0]);
    const sameFullDetail = screen.getByRole('button', { name: strings.fullDetailSamePhoto });
    await act(async () => {
      fireEvent.click(sameFullDetail);
    });

    expect(spokenTexts).toHaveLength(4);
    expect(cueCalls.map((c) => c.cue)).toEqual([strings.statusShortCue]);
    vi.unstubAllGlobals();
  });

  it('probes WebGPU before downloading on laptops: skips Kokoro and starts Piper when no adapter exists, or opts in independently on phones', async () => {
    const phoneRuntime = makeTestRuntime();
    render(
      <App
        coordinator={phoneRuntime.coordinator}
        kokoroClient={phoneRuntime.kokoroClient}
        piperClient={phoneRuntime.piperClient}
        deviceClassOverride="phone"
        hasWebGpuAdapterOverride={async () => true}
      />,
    );
    expect(phoneRuntime.startDownloadSpy).not.toHaveBeenCalled();
    expect(phoneRuntime.piperStartDownloadSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);
    expect(screen.getByTestId('kokoro-status').textContent).toBe(strings.kokoroStatusOff);
    expect(screen.getByTestId('piper-status').textContent).toBe(strings.piperStatusOff);

    const piperOptIn = screen.getByLabelText(
      strings.piperEnablePhoneLabelTemplate.replace('{size}', String(PIPER_TOTAL_SIZE_MB)),
    );
    fireEvent.click(piperOptIn);
    await waitFor(() => {
      expect(phoneRuntime.piperStartDownloadSpy).toHaveBeenCalledTimes(1);
    });
    expect(phoneRuntime.startDownloadSpy).not.toHaveBeenCalled();

    cleanup();

    // Laptop WITHOUT WebGPU adapter skips Kokoro cleanly and downloads Piper instead
    const laptopNoGpu = makeTestRuntime();
    render(
      <App
        coordinator={laptopNoGpu.coordinator}
        kokoroClient={laptopNoGpu.kokoroClient}
        piperClient={laptopNoGpu.piperClient}
        deviceClassOverride="laptop"
        hasWebGpuAdapterOverride={async () => false}
      />,
    );
    await waitFor(() => {
      expect(laptopNoGpu.piperStartDownloadSpy).toHaveBeenCalledTimes(1);
    });
    expect(laptopNoGpu.startDownloadSpy).not.toHaveBeenCalled();
    expect(laptopNoGpu.kokoroClient.getState().status).toBe('skipped');
  });

  it('shows Kokoro and Piper download banners with live timer, measured size, Retry on error, and throttled announcements', async () => {
    vi.useFakeTimers();
    const startMs = new Date('2026-01-01T00:00:00Z').getTime();
    vi.setSystemTime(startMs);

    const { coordinator, kokoroClient, piperClient, piperRetryDownloadSpy } = makeTestRuntime();
    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        piperClient={piperClient}
        deviceClassOverride="laptop"
        hasWebGpuAdapterOverride={async () => true}
      />,
    );

    expect(screen.queryByTestId('kokoro-banner')).toBeNull();

    // Start Kokoro WebGPU ~330 MB
    act(() => {
      kokoroClient.setExternalState({ status: 'downloading', progress: 0, startedAt: startMs, backend: 'webgpu', sizeMb: 330 });
    });

    const banner = screen.getByTestId('kokoro-banner');
    expect(banner.textContent).toContain(strings.kokoroBannerTitle);
    expect(banner.textContent).toContain('about 330 MB');
    expect(banner.textContent).toContain('0%');
    expect(banner.textContent).toContain(`${strings.kokoroElapsedLabel}: 00:00`);
    const progressEl = screen.getByLabelText(strings.kokoroProgressLabel) as HTMLProgressElement;
    expect(progressEl.tagName).toBe('PROGRESS');
    expect(progressEl.closest('[aria-live]')).toBeNull();

    const liveStatus = screen.getByRole('status');
    expect(liveStatus.textContent).toContain(strings.kokoroAnnounceStart);

    // Advance 12 seconds and hit 50% -> midpoint live announcement fires
    act(() => {
      vi.advanceTimersByTime(12_000);
      kokoroClient.setExternalState({ status: 'downloading', progress: 50, startedAt: startMs });
    });
    expect(screen.getByTestId('kokoro-banner').textContent).toContain(`${strings.kokoroElapsedLabel}: 00:12`);
    expect(liveStatus.textContent).toContain(strings.kokoroAnnounceHalf);

    // Kokoro finishes calibration as tooSlow -> Piper banner takes over with real measured MB
    act(() => {
      kokoroClient.setExternalState({ status: 'ready', progress: 100, tooSlow: true, startedAt: null });
      piperClient.setExternalState({ status: 'downloading', progress: 25, startedAt: startMs, sizeMb: PIPER_TOTAL_SIZE_MB });
    });
    const piperBanner = screen.getByTestId('kokoro-banner');
    expect(piperBanner.textContent).toContain(`about ${PIPER_TOTAL_SIZE_MB} MB`);
    expect(piperBanner.textContent).toContain('25%');

    // Piper error triggers Retry button wired to piper.retryDownload
    act(() => {
      piperClient.setExternalState({ status: 'error', progress: 0, error: 'HF offline' });
    });
    expect(screen.getByTestId('kokoro-banner').textContent).toContain(strings.piperStatusError);
    fireEvent.click(screen.getByRole('button', { name: strings.kokoroRetryButton }));
    expect(piperRetryDownloadSpy).toHaveBeenCalledTimes(1);
  });

  it('shows Saved feedback, active voice switch, Piper download/preview on WebGPU laptops, and Kokoro tooSlow notice', async () => {
    const {
      coordinator,
      kokoroClient,
      piperClient,
      piperStartDownloadSpy,
      playClickSound,
      kokoroSpokenTexts,
      piperSpokenTexts,
      spokenTexts,
    } = makeTestRuntime();
    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        piperClient={piperClient}
        deviceClassOverride="laptop"
        hasWebGpuAdapterOverride={async () => true}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);

    const autoReadToggle = screen.getByLabelText(new RegExp(strings.autoReadLabel));
    fireEvent.click(autoReadToggle);
    expect(playClickSound).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('settings-saved-badge').textContent).toContain(strings.settingsSaved);

    // Explicit Download Piper button is available on WebGPU laptops while Piper is in standby
    const downloadPiperBtn = screen.getByRole('button', {
      name: strings.piperDownloadButtonTemplate.replace('{size}', String(PIPER_TOTAL_SIZE_MB)),
    });
    expect(downloadPiperBtn).toBeDefined();

    // Clicking Preview Piper while idle starts downloading Piper and waits quietly without using device voice
    fireEvent.click(screen.getByRole('button', { name: strings.piperPreviewButton }));
    expect(piperStartDownloadSpy).toHaveBeenCalledTimes(1);
    expect(spokenTexts).toEqual([]);
    expect(piperSpokenTexts).toEqual([]);
    expect(screen.getByTestId('piper-preview-note').textContent).toBe(strings.piperPreviewNotReady);

    // Mark Kokoro tooSlow and Piper ready -> Active voice becomes Piper and pending Piper preview auto-plays
    act(() => {
      kokoroClient.setExternalState({ status: 'ready', progress: 100, tooSlow: true, startedAt: null });
      piperClient.setExternalState({ status: 'ready', progress: 100, tooSlow: false, startedAt: null });
    });
    expect(screen.getByTestId('kokoro-status').textContent).toBe(strings.kokoroTooSlow);
    expect(screen.getByTestId('piper-status').textContent).toBe(strings.piperStatusReady);
    expect(screen.getByTestId('active-voice-status').textContent).toBe(
      `${strings.activeVoicePrefix}: ${strings.activeVoicePiper}`,
    );
    expect(piperSpokenTexts).toEqual([strings.piperPreviewText]);

    // Explicit Preview click when already ready speaks immediately too
    fireEvent.click(screen.getByRole('button', { name: strings.piperPreviewButton }));
    expect(piperSpokenTexts).toEqual([strings.piperPreviewText, strings.piperPreviewText]);

    // When Kokoro is ready and fast, Active voice switches to Kokoro
    act(() => {
      kokoroClient.setExternalState({ status: 'ready', progress: 100, tooSlow: false, startedAt: null });
    });
    expect(screen.getByTestId('active-voice-status').textContent).toBe(
      `${strings.activeVoicePrefix}: ${strings.activeVoiceKokoro}`,
    );

    const voiceSelect = screen.getByLabelText(strings.kokoroVoiceSelectLabel) as HTMLSelectElement;
    fireEvent.change(voiceSelect, { target: { value: 'am_michael' } });
    expect(kokoroSpokenTexts).toEqual([
      {
        text: strings.kokoroPreviewTemplate.replace('{name}', 'Michael'),
        voice: 'am_michael',
      },
    ]);

    // Switching Preferred voice order to piper-first switches Active voice back to Piper
    const orderSelect = screen.getByLabelText(strings.voiceOrderLabel) as HTMLSelectElement;
    fireEvent.change(orderSelect, { target: { value: 'piper-first' } });
    expect(screen.getByTestId('active-voice-status').textContent).toBe(
      `${strings.activeVoicePrefix}: ${strings.activeVoicePiper}`,
    );
  });

  it('supports Device voice picker, immediate short-name preview, missing-voice fallback, and matching Describing cue voice', () => {
    const fakeVoices = [
      { name: 'Allison (Enhanced)', lang: 'en-US', default: false, localService: true, voiceURI: 'allison' },
      { name: 'Google US English', lang: 'en-US', default: false, localService: false, voiceURI: 'google-us' },
      { name: 'Samantha', lang: 'en-US', default: true, localService: true, voiceURI: 'samantha' },
    ] as unknown as SpeechSynthesisVoice[];

    const { coordinator, kokoroClient, piperClient, deviceCalls, cueCalls } = makeTestRuntime();
    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        piperClient={piperClient}
        deviceClassOverride="phone"
        deviceVoicesOverride={fakeVoices}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);
    const deviceSelect = screen.getByLabelText(strings.deviceVoiceLabel) as HTMLSelectElement;
    expect(deviceSelect.value).toBe('');
    expect(deviceSelect.options[0].textContent).toBe(strings.deviceVoiceAuto);

    fireEvent.change(deviceSelect, { target: { value: 'Allison (Enhanced)' } });
    expect(deviceSelect.value).toBe('Allison (Enhanced)');
    expect(deviceCalls).toContainEqual({
      text: strings.deviceVoicePreviewTemplate.replace('{name}', 'Allison'),
      deviceVoiceName: 'Allison (Enhanced)',
      online: true,
    });

    fireEvent.click(screen.getAllByRole('button', { name: strings.tabCamera })[0]);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(strings.quickLook) }));
    expect(cueCalls[0]).toEqual({
      cue: strings.statusShortCue,
      deviceVoiceName: 'Allison (Enhanced)',
      online: true,
    });

    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);
    const deviceSelect2 = screen.getByLabelText(strings.deviceVoiceLabel) as HTMLSelectElement;
    fireEvent.change(deviceSelect2, { target: { value: 'Google US English' } });
    expect(screen.queryByTestId('device-voice-unavailable')).toBeNull();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fireEvent(window, new Event('offline'));
    expect(screen.getByTestId('device-voice-unavailable').textContent).toBe(strings.deviceVoiceUnavailable);
    expect(deviceSelect2.value).toBe('Google US English');

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    fireEvent(window, new Event('online'));
    expect(screen.queryByTestId('device-voice-unavailable')).toBeNull();
  });

  it('shows a clear fallback message if optional live viewfinder camera access is denied', async () => {
    const { coordinator, kokoroClient, piperClient } = makeTestRuntime();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')),
      },
    });

    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        piperClient={piperClient}
        deviceClassOverride="phone"
      />,
    );
    const toggleBtn = screen.getByRole('button', { name: strings.liveViewfinderShow });
    await act(async () => {
      fireEvent.click(toggleBtn);
    });

    expect(screen.getByRole('status').textContent).toContain(strings.liveViewfinderDenied);
  });

  it('automatically runs the pre-selected Quick look or Full detail mode when uploading via Choose photo', async () => {
    const { coordinator, kokoroClient, piperClient, spokenTexts, unlockAudioContext } = makeTestRuntime();
    vi.spyOn(imagePrep, 'preparePhotoBlob').mockResolvedValue({
      imageDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
      thumbnailDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
      width: 800,
      height: 600,
      byteLength: 128,
    });

    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { mode: string };
      return new Response(
        JSON.stringify({
          text: body.mode === 'detail' ? 'Full painted details.' : 'Quick painting overview.',
          model: 'anthropic/claude-haiku-5.5',
          mode: body.mode,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <App
        coordinator={coordinator}
        kokoroClient={kokoroClient}
        piperClient={piperClient}
        deviceClassOverride="laptop"
      />,
    );

    // Default pre-selected mode is Quick look -> uploading via Choose photo runs describe immediately
    fireEvent.click(screen.getByRole('button', { name: strings.choosePhoto }));
    expect(unlockAudioContext).toHaveBeenCalledTimes(1);

    const galleryInput = screen.getByTestId('gallery-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(galleryInput, {
        target: { files: [new File(['photo1'], 'painting1.jpg', { type: 'image/jpeg' })] },
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Quick painting overview.')).toBeDefined();
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).mode).toBe('describe');
    expect(spokenTexts).toEqual(['Quick painting overview.']);

    // Pre-selecting Full detail runs Full detail automatically on the next uploaded photo
    fireEvent.click(screen.getByRole('radio', { name: strings.modeFullDetailLabel }));
    await act(async () => {
      fireEvent.change(galleryInput, {
        target: { files: [new File(['photo2'], 'painting2.jpg', { type: 'image/jpeg' })] },
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Full painted details.')).toBeDefined();
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).mode).toBe('detail');
    expect(spokenTexts).toEqual(['Quick painting overview.', 'Full painted details.']);
    vi.unstubAllGlobals();
  });

  it('exports MP3 files on-device from Camera and History via Piper or Kokoro, and guides phone users when offline voices are off', async () => {
    const savedEntries: historyStore.HistoryEntry[] = [];
    vi.spyOn(historyStore, 'saveHistoryEntry').mockImplementation(async (entry) => {
      savedEntries.unshift(entry);
    });
    vi.spyOn(historyStore, 'listHistoryEntries').mockImplementation(async () => [...savedEntries]);

    vi.spyOn(imagePrep, 'preparePhotoBlob').mockResolvedValue({
      imageDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
      thumbnailDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
      width: 800,
      height: 600,
      byteLength: 128,
    });

    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            text: 'The water cycle shows evaporation and condensation.',
            model: 'anthropic/claude-haiku-5.5',
            mode: 'describe',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const createdBlobs: Blob[] = [];
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn((blob: Blob) => {
        createdBlobs.push(blob);
        return 'blob:mp3-test-url';
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    const clickedDownloads: Array<{ href: string; download: string }> = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedDownloads.push({ href: this.href, download: this.download });
    });

    try {
      // 1. Phone with offline voices turned off -> helpful guidance in live status
      const phoneRuntime = makeTestRuntime();
      render(
        <App
          coordinator={phoneRuntime.coordinator}
          kokoroClient={phoneRuntime.kokoroClient}
          piperClient={phoneRuntime.piperClient}
          deviceClassOverride="phone"
        />,
      );

      const phoneGallery = screen.getByTestId('gallery-input') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(phoneGallery, {
          target: { files: [new File(['photo'], 'water_cycle.png', { type: 'image/png' })] },
        });
      });
      await waitFor(() => {
        expect(screen.getByTestId('download-mp3-button')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('download-mp3-button'));
      expect(screen.getByRole('status').textContent).toContain(strings.mp3NeedsOfflineVoicePhone);
      expect(clickedDownloads).toHaveLength(0);

      cleanup();

      // 2. Laptop with Piper ready -> downloads real MP3 from Camera view using photo name
      const laptopRuntime = makeTestRuntime();
      laptopRuntime.kokoroClient.setExternalState({ status: 'skipped', progress: 0 });
      laptopRuntime.piperClient.setExternalState({ status: 'ready', progress: 100, tooSlow: false });
      const piperWavSpy = vi
        .spyOn(laptopRuntime.piperClient, 'synthesizeToWavChunks')
        .mockResolvedValue([buildTestWavArrayBuffer({ sampleRate: 22050, numSamples: 4410, amplitude: 6000 })]);

      render(
        <App
          coordinator={laptopRuntime.coordinator}
          kokoroClient={laptopRuntime.kokoroClient}
          piperClient={laptopRuntime.piperClient}
          deviceClassOverride="laptop"
          hasWebGpuAdapterOverride={async () => false}
        />,
      );

      const laptopGallery = screen.getByTestId('gallery-input') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(laptopGallery, {
          target: { files: [new File(['photo'], 'water_cycle.png', { type: 'image/png' })] },
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('download-mp3-button')).toBeDefined();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('download-mp3-button'));
      });

      await waitFor(() => {
        expect(clickedDownloads).toHaveLength(1);
      });
      expect(piperWavSpy).toHaveBeenCalledTimes(1);
      expect(clickedDownloads[0].download).toBe('water-cycle-quick-look.mp3');
      expect(createdBlobs[0].type).toBe('audio/mpeg');
      expect(createdBlobs[0].size).toBeGreaterThan(500);
      expect(screen.getByRole('status').textContent).toContain(
        strings.mp3ReadyStatusTemplate.replace('{voice}', strings.activeVoicePiper),
      );

      // 3. Switch Kokoro to ready and download again from History tab
      act(() => {
        laptopRuntime.kokoroClient.setExternalState({ status: 'ready', progress: 100, tooSlow: false });
      });
      const kokoroSamples = new Float32Array(4800);
      for (let i = 0; i < kokoroSamples.length; i += 1) {
        kokoroSamples[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / 24000);
      }
      const kokoroChunkSpy = vi
        .spyOn(laptopRuntime.kokoroClient, 'synthesizeToChunks')
        .mockResolvedValue([{ samples: kokoroSamples, sampleRate: 24000 }]);

      fireEvent.click(screen.getAllByRole('button', { name: strings.tabHistory })[0]);
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: strings.historyDownloadMp3 }).length).toBeGreaterThan(0);
      });

      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: strings.historyDownloadMp3 })[0]);
      });

      await waitFor(() => {
        expect(clickedDownloads).toHaveLength(2);
      });
      expect(kokoroChunkSpy).toHaveBeenCalledTimes(1);
      expect(clickedDownloads[1].download).toBe('water-cycle-quick-look.mp3');
      expect(createdBlobs[1].type).toBe('audio/mpeg');
      expect(screen.getByRole('status').textContent).toContain(
        strings.mp3ReadyStatusTemplate.replace('{voice}', strings.activeVoiceKokoro),
      );
    } finally {
      clickSpy.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: originalCreateObjectURL,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: originalRevokeObjectURL,
      });
      vi.unstubAllGlobals();
    }
  });

  it('supports editing descriptions, copying original/edited text, syncing History, resetting to original, and disabling editing persistently', async () => {
    const savedEntries: historyStore.HistoryEntry[] = [];
    vi.spyOn(historyStore, 'saveHistoryEntry').mockImplementation(async (entry) => {
      const idx = savedEntries.findIndex((item) => item.id === entry.id);
      if (idx >= 0) {
        savedEntries[idx] = entry;
      } else {
        savedEntries.unshift(entry);
      }
    });
    vi.spyOn(historyStore, 'listHistoryEntries').mockImplementation(async () => [...savedEntries]);

    vi.spyOn(imagePrep, 'preparePhotoBlob').mockResolvedValue({
      imageDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
      thumbnailDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
      width: 800,
      height: 600,
      byteLength: 128,
    });

    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            text: 'Original worksheet description with typo.',
            model: 'anthropic/claude-haiku-5.5',
            mode: 'describe',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const runtime1 = makeTestRuntime();
    render(
      <App
        coordinator={runtime1.coordinator}
        kokoroClient={runtime1.kokoroClient}
        piperClient={runtime1.piperClient}
        deviceClassOverride="laptop"
        hasWebGpuAdapterOverride={async () => false}
      />,
    );

    const galleryInput = screen.getByTestId('gallery-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(galleryInput, {
        target: { files: [new File(['photo'], 'worksheet.png', { type: 'image/png' })] },
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Original worksheet description with typo.')).toBeDefined();
    });

    // Copy original text right away
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: strings.copyText }));
    });
    expect(writeText).toHaveBeenLastCalledWith('Original worksheet description with typo.');
    expect(screen.getByRole('status').textContent).toContain(strings.copySuccessStatus);

    // Edit description -> validate blank -> save valid revision
    fireEvent.click(screen.getByRole('button', { name: strings.editDescription }));
    const editor = screen.getByLabelText(strings.editTextareaLabel) as HTMLTextAreaElement;
    expect(editor.value).toBe('Original worksheet description with typo.');

    fireEvent.change(editor, { target: { value: '   ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: strings.saveChanges }));
    });
    expect(screen.getByRole('alert').textContent).toBe(strings.editEmptyError);

    fireEvent.change(editor, { target: { value: 'Corrected worksheet description for Schoology.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: strings.saveChanges }));
    });

    expect(screen.getByText('Corrected worksheet description for Schoology.')).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain(strings.editSavedStatus);

    // Speech & Copy text use the updated text
    fireEvent.click(screen.getByRole('button', { name: strings.playAloud }));
    expect(runtime1.spokenTexts.at(-1)).toBe('Corrected worksheet description for Schoology.');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: strings.copyText }));
    });
    expect(writeText).toHaveBeenLastCalledWith('Corrected worksheet description for Schoology.');

    // History synced with Edited tag and updated text
    fireEvent.click(screen.getAllByRole('button', { name: strings.tabHistory })[0]);
    expect(screen.getByText('Corrected worksheet description for Schoology.')).toBeDefined();
    expect(screen.getByText(new RegExp(strings.editedTag))).toBeDefined();

    // Return to Camera -> first click on Reset to original asks "Sure?" in red without resetting yet
    fireEvent.click(screen.getAllByRole('button', { name: strings.tabCamera })[0]);
    fireEvent.click(screen.getByRole('button', { name: strings.resetToOriginal }));
    const confirmBtn = screen.getByRole('button', { name: strings.confirmResetToOriginal });
    expect(confirmBtn.className).toContain('danger-button');
    expect(screen.getByText('Corrected worksheet description for Schoology.')).toBeDefined();

    // Second click ("Sure?") actually resets and replaces button with "Bring back edits"
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    expect(screen.getByText('Original worksheet description with typo.')).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain(strings.editResetStatus);
    expect(screen.queryByRole('button', { name: strings.resetToOriginal })).toBeNull();
    const bringBackBtn = screen.getByRole('button', { name: strings.bringBackEdits });
    expect(bringBackBtn).toBeDefined();

    // Clicking "Bring back edits" restores the edited description and brings Reset back
    await act(async () => {
      fireEvent.click(bringBackBtn);
    });
    expect(screen.getByText('Corrected worksheet description for Schoology.')).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain(strings.editBroughtBackStatus);
    expect(screen.getByRole('button', { name: strings.resetToOriginal })).toBeDefined();

    // Enable Disable description editing in Settings -> persists and hides Edit/Reset/Bring-back while keeping Copy text & tap-to-pause
    fireEvent.click(screen.getAllByRole('button', { name: strings.tabInfo })[0]);
    const disableToggle = screen.getByLabelText(new RegExp(strings.disableEditingLabel)) as HTMLInputElement;
    expect(disableToggle.checked).toBe(false);
    fireEvent.click(disableToggle);
    expect(disableToggle.checked).toBe(true);
    expect(loadSettings().disableEditing).toBe(true);

    fireEvent.click(screen.getAllByRole('button', { name: strings.tabCamera })[0]);
    expect(screen.queryByRole('button', { name: strings.editDescription })).toBeNull();
    expect(screen.queryByRole('button', { name: strings.resetToOriginal })).toBeNull();
    expect(screen.queryByRole('button', { name: strings.bringBackEdits })).toBeNull();
    expect(screen.getByRole('button', { name: strings.readerTapToPause })).toBeDefined();
    expect(screen.getByRole('button', { name: strings.copyText })).toBeDefined();

    // Re-mounting the app (simulating reopening after closing) preserves disableEditing = true
    cleanup();
    const runtime2 = makeTestRuntime();
    render(
      <App
        coordinator={runtime2.coordinator}
        kokoroClient={runtime2.kokoroClient}
        piperClient={runtime2.piperClient}
        deviceClassOverride="laptop"
        hasWebGpuAdapterOverride={async () => false}
      />,
    );

    const galleryInput2 = screen.getByTestId('gallery-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(galleryInput2, {
        target: { files: [new File(['photo'], 'worksheet2.png', { type: 'image/png' })] },
      });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: strings.copyText })).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: strings.editDescription })).toBeNull();

    vi.unstubAllGlobals();
  });
});
