import { useEffect, useMemo, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import type { PromptMode } from '../shared/prompts.ts';
import { strings } from '../shared/strings.ts';
import { CaptureView, type DescriptionResult } from './components/CaptureView.tsx';
import { HistoryView } from './components/HistoryView.tsx';
import { InfoSettingsView } from './components/InfoSettingsView.tsx';
import { KokoroBanner } from './components/KokoroBanner.tsx';
import {
  clearHistory,
  deleteHistoryEntry,
  listHistoryEntries,
  saveHistoryEntry,
  type HistoryEntry,
} from './historyStore.ts';
import type { PreparedPhoto } from './imagePrep.ts';
import {
  detectDeviceClass,
  KOKORO_VOICES,
  loadSettings,
  saveSettings,
  type AppSettings,
  type DeviceClass,
} from './settings.ts';
import { KokoroBrowserClient, type KokoroState } from './speech/kokoroClient.ts';
import {
  createBrowserDeviceVoiceProvider,
  getBrowserDeviceVoices,
  getDeviceVoiceShortName,
  resolveDeviceVoice,
  SpeechCoordinator,
  subscribeBrowserDeviceVoices,
  type SpeechStatusSnapshot,
  type VoiceProviderId,
} from './speech/speechCoordinator.ts';

export type ActiveTab = 'camera' | 'history' | 'info';

export type AppProps = {
  coordinator?: SpeechCoordinator;
  kokoroClient?: KokoroBrowserClient;
  deviceClassOverride?: DeviceClass;
  deviceVoicesOverride?: readonly SpeechSynthesisVoice[];
};

function createDefaultRuntime() {
  const kokoro = new KokoroBrowserClient();
  const coordinator = new SpeechCoordinator({
    deviceProvider: createBrowserDeviceVoiceProvider(),
    kokoroProvider: {
      id: 'kokoro',
      isReady: () => kokoro.isReady(),
      speak: (cleanedText, callbacks) =>
        kokoro.speak(cleanedText, {
          rate: callbacks.rate,
          voice: callbacks.voice ?? 'af_heart',
          onStart: () => callbacks.onStart?.('kokoro'),
          onEnd: callbacks.onEnd,
          onError: callbacks.onError,
        }),
    },
    unlockAudioContext: () => kokoro.unlockAudioContext(),
    playClickSound: () => kokoro.playSettingsClick(),
  });
  return { kokoro, coordinator };
}

export function App({
  coordinator: injectedCoordinator,
  kokoroClient: injectedKokoro,
  deviceClassOverride,
  deviceVoicesOverride,
}: AppProps = {}) {
  const runtime = useMemo(() => {
    if (injectedCoordinator && injectedKokoro) {
      return { coordinator: injectedCoordinator, kokoro: injectedKokoro };
    }
    const created = createDefaultRuntime();
    return {
      coordinator: injectedCoordinator ?? created.coordinator,
      kokoro: injectedKokoro ?? created.kokoro,
    };
  }, [injectedCoordinator, injectedKokoro]);

  const deviceClass = useMemo(
    () => deviceClassOverride ?? detectDeviceClass(),
    [deviceClassOverride],
  );

  const [online, setOnline] = useState(navigator.onLine);
  const [cacheError, setCacheError] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('camera');
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [deviceVoices, setDeviceVoices] = useState<readonly SpeechSynthesisVoice[]>(
    () => deviceVoicesOverride ?? getBrowserDeviceVoices(),
  );
  const [kokoroState, setKokoroState] = useState<KokoroState>(() => runtime.kokoro.getState());
  const [speechStatus, setSpeechStatus] = useState<SpeechStatusSnapshot>(() => runtime.coordinator.getStatus());
  const [lastVoiceUsed, setLastVoiceUsed] = useState<VoiceProviderId | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [preparedPhoto, setPreparedPhoto] = useState<PreparedPhoto | null>(null);
  const [currentResult, setCurrentResult] = useState<DescriptionResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [savedVisible, setSavedVisible] = useState(false);
  const [savedAnnouncement, setSavedAnnouncement] = useState('');
  const [voicePreviewMessage, setVoicePreviewMessage] = useState<string | null>(null);

  const userRequestedUpdate = useRef(false);
  const reloading = useRef(false);
  const savedHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedSeqRef = useRef(0);
  const kokoroAnnounceStageRef = useRef<'none' | 'start' | 'half' | 'done'>('none');

  const reloadOnce = () => {
    if (!reloading.current) {
      reloading.current = true;
      window.location.reload();
    }
  };

  const {
    offlineReady: [offlineReady],
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError: () => setCacheError(true),
    onNeedReload: () => {
      if (userRequestedUpdate.current) {
        reloadOnce();
      }
    },
  });

  useEffect(() => {
    const updateConnection = () => setOnline(navigator.onLine);
    window.addEventListener('online', updateConnection);
    window.addEventListener('offline', updateConnection);
    return () => {
      window.removeEventListener('online', updateConnection);
      window.removeEventListener('offline', updateConnection);
    };
  }, []);

  useEffect(() => {
    if (deviceVoicesOverride) {
      setDeviceVoices(deviceVoicesOverride);
      return;
    }
    return subscribeBrowserDeviceVoices(setDeviceVoices);
  }, [deviceVoicesOverride]);

  useEffect(() => {
    const unsubKokoro = runtime.kokoro.subscribe((next) => {
      setKokoroState(next);

      // Throttled screen-reader announcements: ONLY start, 50%, and done/error.
      if (next.status === 'downloading') {
        if (kokoroAnnounceStageRef.current === 'none' || kokoroAnnounceStageRef.current === 'done') {
          kokoroAnnounceStageRef.current = 'start';
          setStatusMessage(strings.kokoroAnnounceStart);
        } else if (next.progress >= 50 && kokoroAnnounceStageRef.current === 'start') {
          kokoroAnnounceStageRef.current = 'half';
          setStatusMessage(strings.kokoroAnnounceHalf);
        }
      } else if (next.status === 'ready') {
        if (kokoroAnnounceStageRef.current === 'start' || kokoroAnnounceStageRef.current === 'half') {
          kokoroAnnounceStageRef.current = 'done';
          setStatusMessage(strings.kokoroAnnounceReady);
        }
      } else if (next.status === 'error') {
        if (kokoroAnnounceStageRef.current !== 'done') {
          kokoroAnnounceStageRef.current = 'done';
          setStatusMessage(strings.kokoroStatusError);
        }
      } else if (next.status === 'idle') {
        kokoroAnnounceStageRef.current = 'none';
      }
    });
    const unsubSpeech = runtime.coordinator.subscribe((snapshot) => {
      setSpeechStatus(snapshot);
    });
    void listHistoryEntries().then(setHistory);
    return () => {
      unsubKokoro();
      unsubSpeech();
      runtime.coordinator.stop();
      if (savedHideTimerRef.current !== null) {
        clearTimeout(savedHideTimerRef.current);
      }
    };
  }, [runtime]);

  // Download Kokoro automatically ONLY on laptops (or on phones when user explicitly opted in).
  useEffect(() => {
    const allowedToDownload =
      online &&
      (deviceClass === 'laptop' || (deviceClass === 'phone' && settings.kokoroEnabledOnPhone));
    if (allowedToDownload && runtime.kokoro.getState().status === 'idle') {
      runtime.kokoro.startDownload();
    }
  }, [online, deviceClass, settings.kokoroEnabledOnPhone, runtime.kokoro]);

  const handleUpdate = async () => {
    userRequestedUpdate.current = true;
    const hasServiceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
    if (hasServiceWorker) {
      navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
    }
    try {
      await updateServiceWorker(true);
      if (hasServiceWorker) {
        const reg = await navigator.serviceWorker.getRegistration('/');
        if (reg?.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        } else {
          navigator.serviceWorker.removeEventListener('controllerchange', reloadOnce);
          reloadOnce();
        }
      }
    } catch {
      userRequestedUpdate.current = false;
      if (hasServiceWorker) {
        navigator.serviceWorker.removeEventListener('controllerchange', reloadOnce);
      }
      setCacheError(true);
    }
  };

  const triggerSavedFeedback = (customLiveNotice?: string) => {
    runtime.coordinator.playSettingsClick();
    setSavedVisible(true);
    savedSeqRef.current += 1;
    // Toggle briefly when repeated so screen readers still catch consecutive saves quietly.
    const seq = savedSeqRef.current;
    setSavedAnnouncement('');
    queueMicrotask(() => {
      if (savedSeqRef.current === seq) {
        setSavedAnnouncement(customLiveNotice ?? strings.settingsSaved);
      }
    });

    if (savedHideTimerRef.current !== null) {
      clearTimeout(savedHideTimerRef.current);
    }
    savedHideTimerRef.current = setTimeout(() => {
      setSavedVisible(false);
    }, 3000);
  };

  const updateSettings = (patch: Partial<AppSettings>, customLiveNotice?: string) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
    triggerSavedFeedback(customLiveNotice);
  };

  const deviceVoiceResolution = useMemo(
    () =>
      resolveDeviceVoice(deviceVoices, {
        preferredVoiceName: settings.deviceVoiceName,
        online,
      }),
    [deviceVoices, settings.deviceVoiceName, online],
  );

  const speakText = (text: string, rateOverride?: number, voiceOverride?: string) => {
    const kokoroAllowed = deviceClass === 'laptop' || settings.kokoroEnabledOnPhone;
    const initial = runtime.coordinator.speakJob(text, {
      deviceClass,
      voiceOrder: settings.voiceOrder,
      rate: rateOverride ?? settings.speechRate,
      kokoroVoiceId: voiceOverride ?? settings.kokoroVoiceId,
      deviceVoiceName: settings.deviceVoiceName,
      online,
      kokoroAllowed,
      kokoroTooSlow: kokoroState.tooSlow,
      onProviderStarted: (provider) => {
        setLastVoiceUsed(provider);
      },
    });
    if (initial) {
      setLastVoiceUsed(initial);
    }
  };

  const handleSelectDeviceVoice = (voiceName: string | null) => {
    const nextResolution = resolveDeviceVoice(deviceVoices, {
      preferredVoiceName: voiceName,
      online,
    });
    const unavailable = Boolean(voiceName && nextResolution.preferredMissing);
    updateSettings(
      { deviceVoiceName: voiceName },
      unavailable ? strings.deviceVoiceUnavailable : undefined,
    );

    if (unavailable) {
      return;
    }

    const pickedName = nextResolution.voice?.name ?? voiceName;
    if (!pickedName) return;
    const shortName = getDeviceVoiceShortName(pickedName);
    const greeting = strings.deviceVoicePreviewTemplate.replace('{name}', shortName);
    runtime.coordinator.unlockAudioOnly();
    runtime.coordinator.speakJob(greeting, {
      deviceClass,
      voiceOrder: 'device-first',
      rate: settings.speechRate,
      kokoroVoiceId: settings.kokoroVoiceId,
      deviceVoiceName: voiceName,
      online,
      forceProvider: 'device',
    });
  };

  const handleSelectKokoroVoice = (voiceId: string) => {
    const voiceMeta = KOKORO_VOICES.find((v) => v.id === voiceId) ?? KOKORO_VOICES[0];
    const kokoroAllowed = deviceClass === 'laptop' || settings.kokoroEnabledOnPhone;
    const kokoroReady = kokoroAllowed && runtime.kokoro.isReady();

    if (!kokoroReady) {
      const waitMessage = strings.kokoroPreviewNotReadyTemplate.replace('{name}', voiceMeta.shortName);
      setVoicePreviewMessage(waitMessage);
      updateSettings({ kokoroVoiceId: voiceId }, waitMessage);
      return;
    }

    setVoicePreviewMessage(null);
    updateSettings({ kokoroVoiceId: voiceId });

    const greeting = strings.kokoroPreviewTemplate.replace('{name}', voiceMeta.shortName);
    runtime.coordinator.unlockAudioOnly();
    runtime.coordinator.speakJob(greeting, {
      deviceClass,
      voiceOrder: 'kokoro-first',
      rate: settings.speechRate,
      kokoroVoiceId: voiceId,
      kokoroAllowed: true,
      kokoroTooSlow: false,
      forceProvider: 'kokoro',
    });
  };

  const handleUnlockCapture = () => {
    runtime.coordinator.unlockOnCaptureTap({
      speakCue: settings.autoRead,
      deviceVoiceName: settings.deviceVoiceName,
      online,
    });
  };

  const handleUnlockPlayback = () => {
    runtime.coordinator.unlockAudioOnly();
  };

  const handleDescribePrepared = async (photo: PreparedPhoto, mode: PromptMode) => {
    if (!online) {
      setStatusMessage(strings.statusOfflineCannotDescribe);
      return;
    }

    setBusy(true);
    setStatusMessage(strings.statusDescribing);

    try {
      const response = await fetch('/api/describe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          imageDataUrl: photo.imageDataUrl,
        }),
      });

      const data = (await response.json().catch(() => null)) as
        | { text?: string; model?: string; mode?: PromptMode; message?: string }
        | null;

      if (!response.ok || !data?.text) {
        setStatusMessage(data?.message ?? strings.errDescribeFailed);
        return;
      }

      const entry: HistoryEntry = {
        id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        mode: data.mode ?? mode,
        model: data.model ?? 'vision',
        text: data.text,
        thumbnailDataUrl: photo.thumbnailDataUrl,
      };

      setCurrentResult(entry);
      setStatusMessage(strings.statusReady);
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate([30, 50, 30]);
      }

      await saveHistoryEntry(entry);
      setHistory(await listHistoryEntries());

      if (settings.autoRead) {
        speakText(entry.text);
      }
    } catch {
      setStatusMessage(
        navigator.onLine ? strings.errDescribeFailed : strings.statusOfflineCannotDescribe,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePause = () => {
    const result = runtime.coordinator.togglePause();
    if (result === 'paused') {
      setStatusMessage(strings.statusPaused);
    } else if (result === 'resumed') {
      setStatusMessage(strings.statusResumed);
    }
  };

  const handleRepeat = () => {
    if (!currentResult) return;
    speakText(currentResult.text);
  };

  const handleStopSpeech = () => {
    runtime.coordinator.stop();
    setStatusMessage(strings.statusStopped);
  };

  const handleDeleteHistory = async (id: string) => {
    await deleteHistoryEntry(id);
    setHistory(await listHistoryEntries());
    setStatusMessage(strings.historyDeletedStatus);
  };

  const handleClearHistory = async () => {
    await clearHistory();
    setHistory([]);
    setStatusMessage(strings.historyClearedStatus);
  };

  const tabs: ReadonlyArray<{ id: ActiveTab; label: string }> = [
    { id: 'camera', label: strings.tabCamera },
    { id: 'history', label: strings.tabHistory },
    { id: 'info', label: strings.tabInfo },
  ];

  return (
    <>
      <a className="skip-link" href="#main">{strings.skipLink}</a>

      <div className="mx-auto max-w-6xl px-4 pb-28 pt-5 sm:px-8 lg:pb-12 lg:pt-8">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-4 border-b pb-4">
          <div className="flex items-center gap-3">
            <img src="/icons/icon.svg" alt="" width="48" height="48" />
            <div>
              <p className="text-2xl font-bold tracking-tight">{strings.appName}</p>
              <p className="text-sm opacity-85">{strings.suite}</p>
            </div>
          </div>

          {/* Desktop & tablet top navigation */}
          <nav aria-label={strings.navLabel} className="hidden gap-2 lg:flex">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                aria-current={activeTab === tab.id ? 'page' : undefined}
                onClick={() => setActiveTab(tab.id)}
                className={
                  activeTab === tab.id
                    ? 'nav-tab-active min-h-[48px] rounded-xl px-5 py-2 text-base font-bold'
                    : 'nav-tab-idle surface-button min-h-[48px] rounded-xl border-2 px-5 py-2 text-base font-bold'
                }
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </header>

        <main id="main" tabIndex={-1}>
          {/* Visible Kokoro download banner directly under header on Camera screen */}
          {activeTab === 'camera' && (
            <KokoroBanner
              kokoroState={kokoroState}
              onRetry={() => runtime.kokoro.retryDownload()}
            />
          )}

          {/* Live status region: concise notices only, never contains description text */}
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="status-panel mb-6 rounded-2xl border-2 px-4 py-3 text-base"
          >
            <p className="font-bold">{online ? strings.online : strings.offline}</p>
            {statusMessage && <p className="mt-1 font-semibold">{statusMessage}</p>}
            {offlineReady && <p className="mt-1">{strings.offlineReady}</p>}
            {cacheError && <p className="mt-1">{strings.offlineError}</p>}
            {needRefresh && <p className="mt-1">{strings.updateReady}</p>}
          </div>

          {needRefresh && (
            <button
              type="button"
              className="update-button mb-6 rounded-xl px-6 py-3 font-bold"
              onClick={() => void handleUpdate()}
            >
              {strings.update}
            </button>
          )}

          {activeTab === 'camera' && (
            <CaptureView
              online={online}
              busy={busy}
              preparedPhoto={preparedPhoto}
              currentResult={currentResult}
              speechStatus={speechStatus}
              lastVoiceUsed={lastVoiceUsed}
              settings={settings}
              onUnlockCapture={handleUnlockCapture}
              onUnlockPlayback={handleUnlockPlayback}
              onPreparedPhoto={setPreparedPhoto}
              onDescribePrepared={handleDescribePrepared}
              onStatusAnnouncement={setStatusMessage}
              onTogglePause={handleTogglePause}
              onPlayResult={(text) => speakText(text)}
              onRepeat={handleRepeat}
              onStopSpeech={handleStopSpeech}
              onRateChange={(rate) => updateSettings({ speechRate: rate })}
            />
          )}

          {activeTab === 'history' && (
            <HistoryView
              entries={history}
              onPlayEntry={(entry) => {
                handleUnlockPlayback();
                setCurrentResult(entry);
                speakText(entry.text);
              }}
              onOpenEntry={(entry) => {
                setCurrentResult(entry);
                setActiveTab('camera');
              }}
              onDeleteEntry={(id) => void handleDeleteHistory(id)}
              onClearAll={() => void handleClearHistory()}
            />
          )}

          {activeTab === 'info' && (
            <InfoSettingsView
              deviceClass={deviceClass}
              online={online}
              settings={settings}
              deviceVoices={deviceVoices}
              deviceVoiceUnavailable={Boolean(settings.deviceVoiceName && deviceVoiceResolution.preferredMissing)}
              kokoroState={kokoroState}
              needRefresh={needRefresh}
              savedVisible={savedVisible}
              savedAnnouncement={savedAnnouncement}
              voicePreviewMessage={voicePreviewMessage}
              onUpdateSettings={updateSettings}
              onSelectDeviceVoice={handleSelectDeviceVoice}
              onSelectKokoroVoice={handleSelectKokoroVoice}
              onRetryKokoro={() => runtime.kokoro.retryDownload()}
              onUpdateApp={() => void handleUpdate()}
            />
          )}
        </main>
      </div>

      {/* Mobile bottom tab bar in natural thumb zone */}
      <nav
        aria-label={strings.navLabel}
        className="nav-bar fixed bottom-0 left-0 right-0 z-40 grid grid-cols-3 border-t backdrop-blur-md lg:hidden"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-current={activeTab === tab.id ? 'page' : undefined}
            onClick={() => setActiveTab(tab.id)}
            className={
              activeTab === tab.id
                ? 'nav-tab-active flex min-h-[60px] items-center justify-center px-2 py-3 text-sm font-bold'
                : 'nav-tab-idle flex min-h-[60px] items-center justify-center px-2 py-3 text-sm font-bold'
            }
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </>
  );
}
