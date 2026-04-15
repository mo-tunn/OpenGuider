export function createTtsPlaybackController({ api, log, state, win = window }) {
  let currentDirectAudio = null;
  let googleChunkPlayToken = 0;

  function getTtsVolume() {
    const numeric = Number(state.getSetting("ttsVolume"));
    if (!Number.isFinite(numeric)) {
      return 1;
    }
    return Math.max(0, Math.min(1, numeric));
  }

  function getTtsRate() {
    const numeric = Number(state.getSetting("ttsRate"));
    if (!Number.isFinite(numeric)) {
      return 1.5;
    }
    return Math.max(1, Math.min(2, numeric));
  }

  function stopDirectAudio() {
    if (!currentDirectAudio) return;
    currentDirectAudio.pause();
    currentDirectAudio.currentTime = 0;
    currentDirectAudio.onended = null;
    currentDirectAudio.onerror = null;
    currentDirectAudio = null;
    log("tts:audio stop");
  }

  function stopGoogleAudio({ notifyIdle = true } = {}) {
    googleChunkPlayToken += 1;
    const currentAudio = state.getGoogleCurrentAudio();
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio.onended = null;
      currentAudio.onerror = null;
    }

    state.setGoogleCurrentAudio(null);
    state.clearGoogleAudioQueue();
    if (notifyIdle) {
      api.send("update-widget-state", "idle");
    }
    log("tts:google stop");
  }

  function stopAllPlayback({ notifyIdle = true } = {}) {
    win.speechSynthesis.cancel();
    stopDirectAudio();
    stopGoogleAudio({ notifyIdle: false });
    if (notifyIdle) {
      api.send("update-widget-state", "idle");
    }
  }

  function hasActivePlayback() {
    return Boolean(
      currentDirectAudio
      || state.getGoogleCurrentAudio()
      || state.getGoogleAudioQueueLength() > 0
      || win.speechSynthesis.speaking
      || win.speechSynthesis.pending,
    );
  }

  function playAudioWhenReady(audio) {
    let started = false;
    let fallbackTimer = null;
    const cleanup = () => {
      if (fallbackTimer) {
        win.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      audio.removeEventListener("loadeddata", safePlay);
      audio.removeEventListener("canplay", safePlay);
      audio.removeEventListener("canplaythrough", safePlay);
    };
    const safePlay = () => {
      if (started) return;
      started = true;
      cleanup();
      audio.currentTime = 0;
      audio.play().catch(() => {});
    };
    audio.preload = "auto";
    audio.addEventListener("loadeddata", safePlay);
    audio.addEventListener("canplay", safePlay);
    audio.addEventListener("canplaythrough", safePlay);
    // Fallback only if browser never emits readiness events.
    fallbackTimer = win.setTimeout(safePlay, 800);
    audio.load();
  }

  function playNextGoogleAudio() {
    if (state.getGoogleAudioQueueLength() === 0) {
      api.send("update-widget-state", "idle");
      return;
    }

    const base64 = state.shiftGoogleAudioQueue();
    const playbackToken = googleChunkPlayToken;
    const audio = new Audio(`data:audio/mpeg;base64,${base64}`);
    audio.playbackRate = getTtsRate();
    audio.volume = getTtsVolume();
    audio.onended = () => {
      if (playbackToken !== googleChunkPlayToken) return;
      playNextGoogleAudio();
    };
    audio.onerror = () => {
      if (playbackToken !== googleChunkPlayToken) return;
      playNextGoogleAudio();
    };

    state.setGoogleCurrentAudio(audio);
    log("tts:google chunk play");
    playAudioWhenReady(audio);
  }

  function handleTtsStart(base64Audio) {
    log("ipc:tts-start received");
    stopAllPlayback({ notifyIdle: false });
    api.send("update-widget-state", "speaking");
    const audio = new Audio(`data:audio/mpeg;base64,${base64Audio}`);
    audio.playbackRate = getTtsRate();
    audio.volume = getTtsVolume();
    currentDirectAudio = audio;
    audio.onended = () => {
      currentDirectAudio = null;
      api.send("update-widget-state", "idle");
    };
    audio.onerror = () => {
      currentDirectAudio = null;
      api.send("update-widget-state", "idle");
    };
    playAudioWhenReady(audio);
  }

  function handleWebSpeech(data) {
    log("ipc:tts-webspeech received");
    stopAllPlayback({ notifyIdle: false });
    api.send("update-widget-state", "speaking");
    const utterance = new SpeechSynthesisUtterance(data.text);
    if (data.lang) {
      utterance.lang = data.lang;
    }
    utterance.rate = typeof data.rate === "number"
      ? Math.max(1, Math.min(2, data.rate))
      : getTtsRate();
    utterance.volume = getTtsVolume();
    utterance.onend = () => {
      api.send("update-widget-state", "idle");
    };
    utterance.onerror = () => {
      api.send("update-widget-state", "idle");
    };
    win.speechSynthesis.speak(utterance);
  }

  function handleWebSpeechStop(options = {}) {
    log("ipc:tts-webspeech-stop received");
    const suppressIdle = Boolean(options?.suppressIdle);
    stopAllPlayback({ notifyIdle: suppressIdle ? false : hasActivePlayback() });
  }

  function handleGoogleTts(chunksBase64) {
    log("ipc:tts-google received", chunksBase64?.length || 0);
    stopAllPlayback({ notifyIdle: false });
    state.replaceGoogleAudioQueue(chunksBase64);
    if (state.getGoogleAudioQueueLength() > 0) {
      api.send("update-widget-state", "speaking");
    }
    playNextGoogleAudio();
  }

  return {
    handleGoogleTts,
    handleTtsStart,
    handleWebSpeech,
    handleWebSpeechStop,
    playNextGoogleAudio,
    stopGoogleAudio,
  };
}
