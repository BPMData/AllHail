import { useEffect, useMemo, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import type { PromptMode } from '../shared/prompts.ts';
import { strings } from '../shared/strings.ts';
import { CaptureView, type DescriptionResult, type PhotoSelection } from './components/CaptureView.tsx';
import { HistoryView } from './components/HistoryView.tsx';
import { InfoSettingsView } from './components/InfoSettingsView.tsx';
import { KokoroBanner } from './components/KokoroBanner.tsx';
import { ReportView } from './components/ReportView.tsx';
import {
  applyDescriptionEdit,
  clearHistory,
  deleteHistoryEntry,
  listHistoryEntries,
  resetDescriptionToOriginal,
  restoreStashedEdit,
  saveHistoryEntry,
  type HistoryEntry,
} from './historyStore.ts';
import type { PreparedPhoto } from './imagePrep.ts';
import { collectDiagnostics } from './reportDiagnostics.ts';
import {
  detectDeviceClass,
  KOKORO_VOICES,
  loadSettings,
  saveSettings,
  type AppSettings,
  type DeviceClass,
} from './settings.ts';
import { SharedAudioContextManager } from './speech/chunkAudioPlayer.ts';
import { KokoroBrowserClient, type KokoroState } from './speech/kokoroClient.ts';
import {
  buildMp3Filename,
  exportSpeechToMp3,
  resolveMp3Provider,
  triggerMp3Download,
  type OfflineMp3ProviderId,
} from './speech/mp3Export.ts';
import { coordinateOfflineVoiceStartup, probeWebGpuAdapter } from './speech/offlineVoiceController.ts';
import { PiperBrowserClient, type PiperState } from './speech/piperClient.ts';
import {
  createBrowserDeviceVoiceProvider,
  getBrowserDeviceVoices,
  getDeviceVoiceShortName,
  resolveActiveVoiceId,
  resolveDeviceVoice,
  SpeechCoordinator,
  subscribeBrowserDeviceVoices,
  type SpeechStatusSnapshot,
  type VoiceProviderId,
} from './speech/speechCoordinator.ts';

export type ActiveTab = 'camera' | 'history' | 'info' | 'report';

export type AppProps = {
  coordinator?: SpeechCoordinator;
  kokoroClient?: KokoroBrowserClient;
  piperClient?: PiperBrowserClient;
  deviceClassOverride?: DeviceClass;
  deviceVoicesOverride?: readonly SpeechSynthesisVoice[];
  hasWebGpuAdapterOverride?: () => Promise<boolean>;
};

function createDefaultRuntime() {
  const audioManager = new SharedAudioContextManager();
  const kokoro = new KokoroBrowserClient({ audioManager });
  const piper = new PiperBrowserClient({ audioManager });
  const coordinator = new SpeechCoordinator({
    deviceProvider: createBrowserDeviceVoiceProvider(),
    kokoroProvider: {
      id: 'kokoro',
      isReady: () => kokoro.isReady(),
      isBusy: () => kokoro.isBusy(),
      speak: (cleanedText, callbacks) =>
        kokoro.speak(cleanedText, {
          rate: callbacks.rate,
          voice: callbacks.voice ?? 'af_heart',
          onStart: () => callbacks.onStart?.('kokoro'),
          onEnd: callbacks.onEnd,
          onError: callbacks.onError,
        }),
    },
    piperProvider: {
      id: 'piper',
      isReady: () => piper.isReady(),
      isBusy: () => piper.isBusy(),
      speak: (cleanedText, callbacks) =>
        piper.speak(cleanedText, {
          rate: callbacks.rate,
          onStart: () => callbacks.onStart?.('piper'),
          onEnd: callbacks.onEnd,
          onError: callbacks.onError,
        }),
    },
    unlockAudioContext: () => audioManager.unlock(),
    playClickSound: () => audioManager.playSettingsClick(),
  });
  return { kokoro, piper, coordinator };
}

export function App({
  coordinator: injectedCoordinator,
  kokoroClient: injectedKokoro,
  piperClient: injectedPiper,
  deviceClassOverride,
  deviceVoicesOverride,
  hasWebGpuAdapterOverride,
}: AppProps = {}) {
  const runtime = useMemo(() => {
    if (injectedCoordinator && injectedKokoro && injectedPiper) {
      return {
        coordinator: injectedCoordinator,
        kokoro: injectedKokoro,
        piper: injectedPiper,
      };
    }
    const created = createDefaultRuntime();
    return {
      coordinator: injectedCoordinator ?? created.coordinator,
      kokoro: injectedKokoro ?? created.kokoro,
      piper: injectedPiper ?? created.piper,
    };
  }, [injectedCoordinator, injectedKokoro, injectedPiper]);

  const deviceClass = useMemo(
    () => deviceClassOverride ?? detectDeviceClass(),
    [deviceClassOverride],
  );

  const [online, setOnline] = useState(navigator.onLine);
  const [cacheError, setCacheError] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('camera');
  const [tabBeforeReport, setTabBeforeReport] = useState<ActiveTab>('camera');
  const [statusBeforeReport, setStatusBeforeReport] = useState('');
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [deviceVoices, setDeviceVoices] = useState<readonly SpeechSynthesisVoice[]>(
    () => deviceVoicesOverride ?? getBrowserDeviceVoices(),
  );
  const [kokoroState, setKokoroState] = useState<KokoroState>(() => runtime.kokoro.getState());
  const [piperState, setPiperState] = useState<PiperState>(() => runtime.piper.getState());
  const [speechStatus, setSpeechStatus] = useState<SpeechStatusSnapshot>(() => runtime.coordinator.getStatus());
  const [lastVoiceUsed, setLastVoiceUsed] = useState<VoiceProviderId | null>(null);
  const [busy, setBusy] = useState(false);
  const [mp3Busy, setMp3Busy] = useState(false);
  const [mp3Progress, setMp3Progress] = useState<{ done: number; total: number } | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [selectedPhoto, setSelectedPhoto] = useState<PhotoSelection | null>(null);
  const [selectedMode, setSelectedMode] = useState<PromptMode>('describe');
  const [currentResult, setCurrentResult] = useState<DescriptionResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [savedVisible, setSavedVisible] = useState(false);
  const [savedAnnouncement, setSavedAnnouncement] = useState('');
  const [voicePreviewMessage, setVoicePreviewMessage] = useState<string | null>(null);
  const [piperPreviewMessage, setPiperPreviewMessage] = useState<string | null>(null);

  const userRequestedUpdate = useRef(false);
  const reloading = useRef(false);
  const savedHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedSeqRef = useRef(0);
  const kokoroAnnounceStageRef = useRef<'none' | 'start' | 'half' | 'done'>('none');
  const piperAnnounceStageRef = useRef<'none' | 'start' | 'half' | 'done'>('none');
  const pendingPiperPreviewRef = useRef(false);

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

      if (next.status === 'downloading') {
        if (kokoroAnnounceStageRef.current === 'none' || kokoroAnnounceStageRef.current === 'done') {
          kokoroAnnounceStageRef.current = 'start';
          setStatusMessage(next.cached ? strings.kokoroCachedAnnounceStart : strings.kokoroAnnounceStart);
        } else if (next.progress >= 50 && kokoroAnnounceStageRef.current === 'start') {
          kokoroAnnounceStageRef.current = 'half';
          if (!next.cached) {
            setStatusMessage(strings.kokoroAnnounceHalf);
          }
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
      } else if (next.status === 'idle' || next.status === 'skipped') {
        kokoroAnnounceStageRef.current = 'none';
      }
    });

    const unsubPiper = runtime.piper.subscribe((next) => {
      setPiperState(next);

      if (next.status === 'downloading') {
        if (piperAnnounceStageRef.current === 'none' || piperAnnounceStageRef.current === 'done') {
          piperAnnounceStageRef.current = 'start';
          setStatusMessage(strings.piperAnnounceStart);
        } else if (next.progress >= 50 && piperAnnounceStageRef.current === 'start') {
          piperAnnounceStageRef.current = 'half';
          setStatusMessage(strings.piperAnnounceHalf);
        }
      } else if (next.status === 'ready') {
        if (piperAnnounceStageRef.current === 'start' || piperAnnounceStageRef.current === 'half') {
          piperAnnounceStageRef.current = 'done';
          setStatusMessage(strings.piperAnnounceReady);
        }
      } else if (next.status === 'error') {
        if (piperAnnounceStageRef.current !== 'done') {
          piperAnnounceStageRef.current = 'done';
          setStatusMessage(strings.piperStatusError);
        }
      } else if (next.status === 'idle' || next.status === 'unavailable') {
        piperAnnounceStageRef.current = 'none';
      }
    });

    const unsubSpeech = runtime.coordinator.subscribe((snapshot) => {
      setSpeechStatus(snapshot);
    });
    void listHistoryEntries().then(setHistory);
    return () => {
      unsubKokoro();
      unsubPiper();
      unsubSpeech();
      runtime.coordinator.stop();
      if (savedHideTimerRef.current !== null) {
        clearTimeout(savedHideTimerRef.current);
      }
    };
  }, [runtime]);

  // Decide Kokoro vs Piper before downloading anything on laptops; keep phones opt-in.
  useEffect(() => {
    void coordinateOfflineVoiceStartup({
      online,
      deviceClass,
      voiceOrder: settings.voiceOrder,
      kokoroEnabledOnPhone: settings.kokoroEnabledOnPhone,
      piperEnabledOnPhone: settings.piperEnabledOnPhone,
      hasWebGpuAdapter: hasWebGpuAdapterOverride ?? probeWebGpuAdapter,
      kokoro: runtime.kokoro,
      piper: runtime.piper,
    });
  }, [
    online,
    deviceClass,
    settings.voiceOrder,
    settings.kokoroEnabledOnPhone,
    settings.piperEnabledOnPhone,
    kokoroState.status,
    kokoroState.tooSlow,
    hasWebGpuAdapterOverride,
    runtime.kokoro,
    runtime.piper,
  ]);

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

  const kokoroAllowed = deviceClass === 'laptop' || settings.kokoroEnabledOnPhone;
  const piperAllowed = deviceClass === 'laptop' || settings.piperEnabledOnPhone;

  const activeVoiceId = useMemo(
    () =>
      resolveActiveVoiceId({
        deviceClass,
        voiceOrder: settings.voiceOrder,
        kokoroReady: kokoroState.status === 'ready',
        kokoroAllowed,
        kokoroTooSlow: kokoroState.tooSlow,
        piperReady: piperState.status === 'ready',
        piperAllowed,
        piperTooSlow: piperState.tooSlow,
      }),
    [
      deviceClass,
      settings.voiceOrder,
      kokoroState.status,
      kokoroState.tooSlow,
      kokoroAllowed,
      piperState.status,
      piperState.tooSlow,
      piperAllowed,
    ],
  );

  const speakText = (text: string, rateOverride?: number, voiceOverride?: string) => {
    const initial = runtime.coordinator.speakJob(text, {
      deviceClass,
      voiceOrder: settings.voiceOrder,
      rate: rateOverride ?? settings.speechRate,
      kokoroVoiceId: voiceOverride ?? settings.kokoroVoiceId,
      deviceVoiceName: settings.deviceVoiceName,
      online,
      kokoroAllowed,
      kokoroTooSlow: kokoroState.tooSlow,
      piperAllowed,
      piperTooSlow: piperState.tooSlow,
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

  const playPiperPreviewNow = () => {
    setPiperPreviewMessage(null);
    runtime.coordinator.unlockAudioOnly();
    runtime.coordinator.speakJob(strings.piperPreviewText, {
      deviceClass,
      voiceOrder: 'piper-first',
      rate: settings.speechRate,
      kokoroVoiceId: settings.kokoroVoiceId,
      piperAllowed: true,
      piperTooSlow: false,
      forceProvider: 'piper',
    });
  };

  useEffect(() => {
    if (!pendingPiperPreviewRef.current) return;
    if (piperState.status === 'ready' && piperAllowed) {
      pendingPiperPreviewRef.current = false;
      setPiperPreviewMessage(null);
      if (activeTab === 'info') {
        playPiperPreviewNow();
      }
      return;
    }
    if (piperState.status === 'error' || piperState.status === 'unavailable' || !piperAllowed) {
      pendingPiperPreviewRef.current = false;
      setPiperPreviewMessage(
        piperState.status === 'unavailable' ? strings.piperPreviewUnavailable : strings.piperStatusError,
      );
    }
  }, [piperState.status, piperAllowed, activeTab]);

  const handleDownloadPiper = () => {
    if (piperState.status === 'unavailable') {
      setPiperPreviewMessage(strings.piperPreviewUnavailable);
      triggerSavedFeedback(strings.piperPreviewUnavailable);
      return;
    }
    if (!online) {
      const waitMsg = strings.piperStatusWaitingOnlineTemplate.replace('{size}', String(piperState.sizeMb));
      setPiperPreviewMessage(waitMsg);
      triggerSavedFeedback(waitMsg);
      return;
    }
    setPiperPreviewMessage(null);
    if (piperState.status === 'error') {
      runtime.piper.retryDownload();
    } else if (piperState.status === 'idle') {
      runtime.piper.startDownload();
    }
    triggerSavedFeedback(strings.piperAnnounceStart);
  };

  const handlePreviewPiper = () => {
    if (piperState.status === 'unavailable') {
      pendingPiperPreviewRef.current = false;
      setPiperPreviewMessage(strings.piperPreviewUnavailable);
      triggerSavedFeedback(strings.piperPreviewUnavailable);
      return;
    }
    if (deviceClass === 'phone' && !settings.piperEnabledOnPhone) {
      pendingPiperPreviewRef.current = false;
      setPiperPreviewMessage(strings.piperPreviewPhoneOff);
      triggerSavedFeedback(strings.piperPreviewPhoneOff);
      return;
    }
    const piperReady = piperAllowed && runtime.piper.isReady();
    if (piperReady) {
      pendingPiperPreviewRef.current = false;
      playPiperPreviewNow();
      return;
    }
    if (!online) {
      pendingPiperPreviewRef.current = false;
      const waitMsg = strings.piperStatusWaitingOnlineTemplate.replace('{size}', String(piperState.sizeMb));
      setPiperPreviewMessage(waitMsg);
      triggerSavedFeedback(waitMsg);
      return;
    }

    runtime.coordinator.unlockAudioOnly();
    pendingPiperPreviewRef.current = true;
    if (piperState.status === 'idle') {
      runtime.piper.startDownload();
    } else if (piperState.status === 'error') {
      runtime.piper.retryDownload();
    }
    setPiperPreviewMessage(strings.piperPreviewNotReady);
    triggerSavedFeedback(strings.piperPreviewNotReady);
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

  const handleDescribePrepared = async (
    photo: PreparedPhoto,
    mode: PromptMode,
    sourceName?: string,
  ) => {
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
        sourceName,
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

  const handleNewPhoto = async (photo: PreparedPhoto, mode: PromptMode, sourceName?: string) => {
    setSelectedPhoto({ photo, sourceName, mode, initialMode: mode });
    await handleDescribePrepared(photo, mode, sourceName);
  };

  const handleSwitchPhotoMode = async (mode: PromptMode) => {
    if (!selectedPhoto || busy) return;
    if (!online) {
      setStatusMessage(strings.statusOfflineCannotDescribe);
      return;
    }
    handleUnlockCapture();
    setSelectedMode(mode);
    setSelectedPhoto({ ...selectedPhoto, mode });
    await handleDescribePrepared(selectedPhoto.photo, mode, selectedPhoto.sourceName);
  };

  const mp3Provider = useMemo(
    () =>
      resolveMp3Provider({
        deviceClass,
        voiceOrder: settings.voiceOrder,
        kokoroReady: kokoroState.status === 'ready',
        kokoroAllowed,
        kokoroTooSlow: kokoroState.tooSlow,
        piperReady: piperState.status === 'ready',
        piperAllowed,
        piperTooSlow: piperState.tooSlow,
      }),
    [
      deviceClass,
      settings.voiceOrder,
      kokoroState.status,
      kokoroState.tooSlow,
      kokoroAllowed,
      piperState.status,
      piperState.tooSlow,
      piperAllowed,
    ],
  );

  const handleDownloadMp3 = async (item: {
    text: string;
    mode: PromptMode;
    createdAt: number;
    sourceName?: string;
  }) => {
    if (mp3Busy) return;

    if (!mp3Provider) {
      if (deviceClass === 'phone' && !settings.kokoroEnabledOnPhone && !settings.piperEnabledOnPhone) {
        setStatusMessage(strings.mp3NeedsOfflineVoicePhone);
      } else {
        setStatusMessage(strings.mp3WaitOfflineVoice);
      }
      return;
    }

    setMp3Busy(true);
    setMp3Progress(null);
    setStatusMessage(strings.downloadingMp3);

    const tryExport = async (provider: OfflineMp3ProviderId) =>
      exportSpeechToMp3({
        rawText: item.text,
        provider,
        kokoroVoiceId: settings.kokoroVoiceId,
        speechRate: settings.speechRate,
        kokoroClient: runtime.kokoro,
        piperClient: runtime.piper,
        onProgress: (done, total) => setMp3Progress({ done, total }),
      });

    try {
      let exported: { blob: Blob; provider: OfflineMp3ProviderId };
      try {
        exported = await tryExport(mp3Provider);
      } catch {
        const fallbackProvider: OfflineMp3ProviderId | null =
          mp3Provider === 'kokoro' && piperAllowed && piperState.status === 'ready'
            ? 'piper'
            : mp3Provider === 'piper' && kokoroAllowed && kokoroState.status === 'ready'
              ? 'kokoro'
              : null;
        if (!fallbackProvider) throw new Error('MP3 synthesis failed');
        setMp3Progress(null);
        exported = await tryExport(fallbackProvider);
      }

      const filename = buildMp3Filename({
        sourceName: item.sourceName,
        mode: item.mode,
        createdAt: item.createdAt,
      });
      triggerMp3Download(exported.blob, filename);
      const voiceLabel =
        exported.provider === 'kokoro' ? strings.activeVoiceKokoro : strings.activeVoicePiper;
      setStatusMessage(strings.mp3ReadyStatusTemplate.replace('{voice}', voiceLabel));
    } catch {
      setStatusMessage(strings.mp3Failed);
    } finally {
      setMp3Busy(false);
      setMp3Progress(null);
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

  const handleCopyText = async (text: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setStatusMessage(strings.copySuccessStatus);
        return;
      }
      if (typeof document !== 'undefined') {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
        document.body.removeChild(helper);
        if (copied) {
          setStatusMessage(strings.copySuccessStatus);
          return;
        }
      }
      setStatusMessage(strings.copyFailedStatus);
    } catch {
      setStatusMessage(strings.copyFailedStatus);
    }
  };

  const persistUpdatedEntry = async (updated: HistoryEntry) => {
    setCurrentResult((prev) => (prev?.id === updated.id ? updated : prev));
    await saveHistoryEntry(updated);
    const stored = await listHistoryEntries();
    if (stored.length > 0) {
      setHistory(stored);
    } else {
      setHistory((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    }
  };

  const handleSaveEdit = async (id: string, nextText: string) => {
    const target =
      (currentResult?.id === id ? currentResult : undefined) ??
      history.find((item) => item.id === id);
    if (!target || !nextText.trim()) return;
    runtime.coordinator.stop();
    const updated = applyDescriptionEdit(target, nextText);
    await persistUpdatedEntry(updated);
    setStatusMessage(strings.editSavedStatus);
  };

  const handleResetOriginal = async (id: string, draftOverride?: string) => {
    const target =
      (currentResult?.id === id ? currentResult : undefined) ??
      history.find((item) => item.id === id);
    if (!target) return;
    runtime.coordinator.stop();
    const withDraft =
      draftOverride && draftOverride.trim() && target.originalText
        ? { ...target, text: draftOverride.trim() }
        : target;
    const restored = resetDescriptionToOriginal(withDraft);
    await persistUpdatedEntry(restored);
    setStatusMessage(strings.editResetStatus);
  };

  const handleRestoreStashedEdit = async (id: string) => {
    const target =
      (currentResult?.id === id ? currentResult : undefined) ??
      history.find((item) => item.id === id);
    if (!target || !target.stashedEditedText) return;
    runtime.coordinator.stop();
    const restoredEdit = restoreStashedEdit(target);
    await persistUpdatedEntry(restoredEdit);
    setStatusMessage(strings.editBroughtBackStatus);
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

  const openReport = () => {
    if (activeTab === 'report') return;
    setTabBeforeReport(activeTab);
    // Remember the last app message from before the report opened; it often names the problem.
    setStatusBeforeReport(statusMessage);
    setStatusMessage('');
    setActiveTab('report');
  };

  // Only app, browser and feature facts: never photos, descriptions, history or voice names.
  const getReportDiagnostics = () =>
    collectDiagnostics({
      deviceClass,
      online,
      offlineReady,
      updateWaiting: needRefresh,
      settings,
      deviceVoiceCount: deviceVoices.length,
      deviceVoiceMissing: Boolean(settings.deviceVoiceName && deviceVoiceResolution.preferredMissing),
      activeVoice: activeVoiceId,
      lastVoiceUsed,
      speaking: speechStatus.speaking,
      kokoroState,
      piperState,
      descriptionMode: selectedMode,
      lastStatus: statusBeforeReport,
    });

  const tabs: ReadonlyArray<{ id: ActiveTab; label: string }> = [
    { id: 'camera', label: strings.tabCamera },
    { id: 'history', label: strings.tabHistory },
    { id: 'info', label: strings.tabInfo },
  ];

  return (
    <>
      <a className="skip-link" href="#main">{strings.skipLink}</a>

      <div className="mx-auto max-w-6xl px-4 pb-28 pt-5 sm:px-8 lg:pb-12 lg:pt-8">
        <header className="app-header mb-4 flex flex-wrap items-center justify-between gap-4 border px-4 py-3">
          <div className="flex items-center gap-3">
            <img src="/icons/icon.svg" alt="" width="48" height="48" className="shrink-0 rounded-sm" />
            <div>
              <p className="text-2xl font-bold tracking-tight">{strings.appName}</p>
              <p className="text-sm opacity-85">{strings.suite}</p>
            </div>
          </div>

          <div aria-hidden="true" className="connection-pill">{online ? strings.online : strings.offline}</div>

          <button
            type="button"
            onClick={openReport}
            aria-current={activeTab === 'report' ? 'page' : undefined}
            className="surface-button min-h-[48px] rounded-sm border px-4 py-2 text-base font-bold"
          >
            {strings.reportEntry}
          </button>

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
                    ? 'nav-tab-active min-h-[48px] rounded-sm px-5 py-2 text-base font-bold'
                    : 'nav-tab-idle surface-button min-h-[48px] rounded-sm border px-5 py-2 text-base font-bold'
                }
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </header>

        <main id="main" tabIndex={-1}>
          {/* Visible voice download banner directly under header on Camera screen */}
          {activeTab === 'camera' && (
            <KokoroBanner
              kokoroState={kokoroState}
              piperState={piperState}
              onRetry={() => runtime.kokoro.retryDownload()}
              onRetryPiper={() => runtime.piper.retryDownload()}
            />
          )}

          {/* Live status region: concise notices only, never contains description text */}
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={statusMessage || cacheError || needRefresh ? "status-panel mb-6 rounded-sm border px-4 py-3 text-base" : "sr-only"}
          >
            <p className="sr-only">{online ? strings.online : strings.offline}</p>
            {statusMessage && <p className="mt-1 font-semibold">{statusMessage}</p>}
            {offlineReady && <p className="sr-only">{strings.offlineReady}</p>}
            {cacheError && <p className="mt-1">{strings.offlineError}</p>}
            {needRefresh && <p className="mt-1">{strings.updateReady}</p>}
          </div>

          {needRefresh && (
            <button
              type="button"
              className="update-button mb-6 rounded-sm px-6 py-3 font-bold"
              onClick={() => void handleUpdate()}
            >
              {strings.update}
            </button>
          )}

          {activeTab === 'camera' && (
            <CaptureView
              online={online}
              busy={busy}
              mp3Busy={mp3Busy}
              mp3ProgressLabel={
                mp3Progress
                  ? strings.mp3MakingProgressTemplate
                      .replace('{done}', String(mp3Progress.done))
                      .replace('{total}', String(mp3Progress.total))
                  : null
              }
              selectedPhoto={selectedPhoto}
              selectedMode={selectedMode}
              onModeChange={setSelectedMode}
              onSwitchPhotoMode={handleSwitchPhotoMode}
              currentResult={currentResult}
              speechStatus={speechStatus}
              lastVoiceUsed={lastVoiceUsed}
              settings={settings}
              onUnlockCapture={handleUnlockCapture}
              onUnlockPlayback={handleUnlockPlayback}
              onDescribePrepared={handleNewPhoto}
              onDownloadMp3={(result) => void handleDownloadMp3(result)}
              onCopyText={(text) => void handleCopyText(text)}
              onSaveEdit={handleSaveEdit}
              onResetOriginal={handleResetOriginal}
              onRestoreStashedEdit={handleRestoreStashedEdit}
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
              mp3Busy={mp3Busy}
              onPlayEntry={(entry) => {
                handleUnlockPlayback();
                setCurrentResult(entry);
                speakText(entry.text);
              }}
              onOpenEntry={(entry) => {
                setCurrentResult(entry);
                setActiveTab('camera');
              }}
              onCopyText={(text) => void handleCopyText(text)}
              onDownloadMp3={(entry) => void handleDownloadMp3(entry)}
              onDeleteEntry={(id) => void handleDeleteHistory(id)}
              onClearAll={() => void handleClearHistory()}
            />
          )}

          {activeTab === 'report' && (
            <ReportView
              online={online}
              getDiagnostics={getReportDiagnostics}
              onClose={() => setActiveTab(tabBeforeReport)}
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
              piperState={piperState}
              activeVoiceId={activeVoiceId}
              needRefresh={needRefresh}
              savedVisible={savedVisible}
              savedAnnouncement={savedAnnouncement}
              voicePreviewMessage={voicePreviewMessage}
              piperPreviewMessage={piperPreviewMessage}
              onUpdateSettings={updateSettings}
              onSelectDeviceVoice={handleSelectDeviceVoice}
              onSelectKokoroVoice={handleSelectKokoroVoice}
              onDownloadPiper={handleDownloadPiper}
              onPreviewPiper={handlePreviewPiper}
              onRetryKokoro={() => runtime.kokoro.retryDownload()}
              onRetryPiper={() => runtime.piper.retryDownload()}
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
