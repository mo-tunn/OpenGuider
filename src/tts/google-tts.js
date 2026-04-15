const googleTTS = require("google-tts-api");

async function speakText(text, settings) {
  try {
    const langPattern = settings.sttLanguage || "tr-TR";
    const shortLang = langPattern.split("-")[0]; // "tr" from "tr-TR"

    // To handle long AI responses without limits, use the getAllAudioBase64 function
    const results = await googleTTS.getAllAudioBase64(text, {
      lang: shortLang,
      slow: false,
      host: "https://translate.google.com",
      splitPunct: ",.?!:",
    });

    // returns an array of { shortText, base64 }
    return results.map(r => r.base64);
  } catch (err) {
    console.error("Google TTS error:", err);
    return [];
  }
}

module.exports = { speakText };
