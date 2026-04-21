export function createPttController({
  api,
  dom,
  log,
  messaging,
  state,
  ui,
}) {
  function startPTT() {
    if (state.isRecording()) {
      return;
    }

    // Interrupt any ongoing TTS as soon as user starts speaking.
    api.send("stop-tts", { suppressIdle: true });
    state.setRecording(true);
    dom.pttBtn.classList.add("recording");
    dom.waveform.style.display = "flex";
    dom.pttBtn.childNodes[0].textContent = "";
    api.send("update-widget-state", "listening");
    const sttProvider = resolveSttProvider(state.getSetting("sttProvider"));
    log("stt:start", sttProvider);

    if (sttProvider === "assemblyai") {
      startAssemblyAI();
    } else if (sttProvider === "whisper") {
      startWhisper();
    }

    ui.startWaveformAnimation();
  }

  function stopPTT() {
    if (!state.isRecording()) {
      return;
    }

    state.setRecording(false);
    dom.pttBtn.classList.remove("recording");
    dom.waveform.style.display = "none";
    dom.pttBtn.childNodes[0].textContent = "⏺";
    api.send("update-widget-state", "idle");
    ui.stopWaveformAnimation();

    const recognition = state.getRecognition();
    if (recognition) {
      recognition.stop();
      state.setRecognition(null);
    }

    state.runPttCleanup();
    log("stt:stop");
  }

  function resolveSttProvider(provider) {
    if (provider === "whisper") return "whisper";
    return "assemblyai";
  }

  async function startAssemblyAI() {
    try {
      log("ipc:get-assemblyai-token invoke");
      const token = await api.invoke("get-assemblyai-token");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      const socket = new WebSocket(
        `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&token=${token}`,
      );

      let finalTranscript = "";
      let cleanupDone = false;

      function doCleanup() {
        if (cleanupDone) return;
        cleanupDone = true;
        try { socket.close(); } catch (_ignored) { /* socket may already be closed */ }
        stream.getTracks().forEach((track) => track.stop());
        audioContext.close();
      }

      socket.onopen = () => source.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (event) => {
        if (!state.isRecording() || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        const pcm = floatTo16BitPCM(event.inputBuffer.getChannelData(0));
        socket.send(pcm);
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "FinalTranscript" && message.text) {
          finalTranscript += message.text + " ";
          dom.textInput.value = finalTranscript;
        } else if (message.type === "PartialTranscript") {
          dom.textInput.value = finalTranscript + (message.text || "");
        }
      };

      socket.onerror = (event) => {
        log("stt:assemblyai ws error", event);
        ui.showToast("AssemblyAI connection error", true);
        doCleanup();
        stopPTT();
      };

      socket.onclose = (event) => {
        log("stt:assemblyai ws closed", { code: event.code, reason: event.reason });
        doCleanup();
        // If still recording when socket closes unexpectedly, stop PTT gracefully.
        if (state.isRecording()) {
          stopPTT();
        }
      };

      state.setPttCleanup(() => {
        doCleanup();
        const text = finalTranscript.trim();
        if (text) {
          messaging.sendMessage(text);
        }
      });
    } catch (error) {
      ui.showToast("AssemblyAI error: " + error.message, true);
      log("stt:assemblyai error", error);
      // Force-reset recording state even if stopPTT early-returns.
      state.setRecording(false);
      dom.pttBtn.classList.remove("recording");
      dom.waveform.style.display = "none";
      dom.pttBtn.childNodes[0].textContent = "⏺";
      api.send("update-widget-state", "idle");
      ui.stopWaveformAnimation();
    }
  }

  async function startWhisper() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      const audioChunks = [];

      mediaRecorder.addEventListener("dataavailable", (event) => {
        audioChunks.push(event.data);
      });

      mediaRecorder.addEventListener("stop", async () => {
        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("file", audioBlob, "audio.webm");
        formData.append("model", state.getSetting("whisperModel") || "whisper-1");

        if (state.getSetting("sttLanguage")) {
          const languageCode = state.getSetting("sttLanguage").split("-")[0];
          formData.append("language", languageCode);
        }

        dom.textInput.placeholder = "Transcribing...";
        log("stt:whisper upload start");

        try {
          const baseUrl = (state.getSetting("whisperBaseUrl") || "https://api.openai.com/v1")
            .replace(/\/+$/, "");
          const endpoint = baseUrl.endsWith("/audio/transcriptions")
            ? baseUrl
            : `${baseUrl}/audio/transcriptions`;

          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${state.getSetting("whisperApiKey")}`,
            },
            body: formData,
          });

          if (!response.ok) {
            throw new Error(`Whisper Error ${response.status}: ${await response.text()}`);
          }

          const data = await response.json();
          if (data.text) {
            messaging.sendMessage(data.text);
          }
        } catch (error) {
          ui.showToast("Transcription failed: " + error.message, true);
          log("stt:whisper error", error);
        } finally {
          dom.textInput.placeholder = "Ask anything...";
        }
      });

      mediaRecorder.start();
      state.setPttCleanup(() => {
        if (mediaRecorder.state !== "inactive") {
          mediaRecorder.stop();
        }
        stream.getTracks().forEach((track) => track.stop());
      });
    } catch (error) {
      ui.showToast("Whisper Audio Error: " + error.message, true);
      log("stt:whisper audio error", error);
      stopPTT();
    }
  }

  function floatTo16BitPCM(floatSamples) {
    const buffer = new ArrayBuffer(floatSamples.length * 2);
    const view = new DataView(buffer);

    for (let index = 0; index < floatSamples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, floatSamples[index]));
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    }

    return buffer;
  }

  return {
    startPTT,
    stopPTT,
  };
}
