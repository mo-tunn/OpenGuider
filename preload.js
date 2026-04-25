const { contextBridge, ipcRenderer } = require("electron");

const api = {
  invoke: (ch, ...a) => ipcRenderer.invoke(ch, ...a),
  on: (ch, cb) => {
    const valid = [
      "ai-chunk","ai-done","ai-error",
      "push-to-talk-start","push-to-talk-stop",
      "tts-start","tts-done","show-cursor-at","hide-cursor",
      "settings-changed","tts-webspeech","tts-webspeech-stop","tts-google",
      "state-change", "widget-ready",
      "session-updated","plan-updated","agent-state-changed","pointer-updated",
      "execution:step-pending","execution:step-complete","execution:aborted",
      "execution:substep-progress","browser-agent-status-changed","browser-agent-download-progress"
    ];
    if (!valid.includes(ch)) return;
    const fn = (_e, ...a) => cb(...a);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
  send: (ch, ...a) => {
    const valid = ["show-cursor-at","hide-cursor","stop-tts","panel-ready","widget-loaded","update-widget-state",
      "execution:step-decision","execution:trust-override","execution:retry-step"];
    if (valid.includes(ch)) ipcRenderer.send(ch, ...a);
  },
};

contextBridge.exposeInMainWorld("openguider", api);
