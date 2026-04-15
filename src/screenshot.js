const { desktopCapturer, screen } = require("electron");

let lastCapture = {
  capturedAt: 0,
  images: [],
};
let inFlightCapture = null;

function mapSourceToDisplay(source, displays) {
  const displayId = Number(source.display_id || 0);
  if (displayId) {
    const match = displays.find((display) => Number(display.id) === displayId);
    if (match) {
      return match;
    }
  }
  return null;
}

async function rawCaptureAllScreens() {
  const startedAt = Date.now();
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const maxW = Math.max(...displays.map((d) => d.size.width));
  const maxH = Math.max(...displays.map((d) => d.size.height));

  const getSourcesStartedAt = Date.now();
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: maxW, height: maxH },
  });
  const getSourcesDurationMs = Date.now() - getSourcesStartedAt;

  let encodeDurationMs = 0;
  const images = sources.map((source, index) => {
    const matchedDisplay = mapSourceToDisplay(source, displays);
    const fallbackDisplay = displays[index] || displays[0];
    const display = matchedDisplay || fallbackDisplay;
    const isPrimary = display.id === primary.id;
    const encodeStart = Date.now();
    const jpeg = source.thumbnail.toJPEG(85);
    encodeDurationMs += Date.now() - encodeStart;
    const { width, height } = source.thumbnail.getSize();

    return {
      label: isPrimary ? `Screen ${index + 1} (primary)` : `Screen ${index + 1}`,
      screenNumber: index + 1,
      displayId: String(display.id),
      isPrimary,
      base64Jpeg: jpeg.toString("base64"),
      width,
      height,
    };
  });

  return {
    images,
    timings: {
      totalDurationMs: Date.now() - startedAt,
      getSourcesDurationMs,
      encodeDurationMs,
      sourceCount: sources.length,
      displayCount: displays.length,
      maxWidth: maxW,
      maxHeight: maxH,
      fromCache: false,
    },
  };
}

async function captureAllScreens({
  forceFresh = false,
  maxAgeMs = 900,
  includeTimings = false,
} = {}) {
  const now = Date.now();
  if (!forceFresh && lastCapture.images.length > 0 && now - lastCapture.capturedAt <= maxAgeMs) {
    if (includeTimings) {
      return {
        images: lastCapture.images,
        timings: {
          totalDurationMs: 0,
          getSourcesDurationMs: 0,
          encodeDurationMs: 0,
          sourceCount: lastCapture.images.length,
          displayCount: lastCapture.images.length,
          fromCache: true,
        },
      };
    }
    return lastCapture.images;
  }

  if (inFlightCapture) {
    const inFlightResult = await inFlightCapture;
    return includeTimings ? inFlightResult : inFlightResult.images;
  }

  inFlightCapture = rawCaptureAllScreens()
    .then((result) => {
      lastCapture = {
        capturedAt: Date.now(),
        images: result.images,
      };
      return result;
    })
    .finally(() => {
      inFlightCapture = null;
    });

  const result = await inFlightCapture;
  return includeTimings ? result : result.images;
}

module.exports = {
  captureAllScreens,
};
