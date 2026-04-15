const { exec } = require("child_process");
let currentTTSProcess = null;

function speakText(text) {
  return new Promise((resolve) => {
    stopSpeaking();
    const safe = text.replace(/['"]/g, " ");
    const psScript = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 3; $s.Speak('${safe}')`;
    currentTTSProcess = exec(
      `PowerShell -NoProfile -NonInteractive -Command "${psScript}"`,
      () => { currentTTSProcess = null; resolve(); }
    );
  });
}

function stopSpeaking() {
  if (currentTTSProcess) {
    currentTTSProcess.kill("SIGTERM");
    currentTTSProcess = null;
  }
}

module.exports = { speakText, stopSpeaking };
