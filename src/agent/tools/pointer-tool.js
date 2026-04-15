function normalizeCoordinate(coordinate, displayBounds, calibration = null) {
  if (!coordinate) {
    return null;
  }

  const sourceWidth = Math.max(
    1,
    Number(calibration?.sourceWidth) || Number(displayBounds.width) || 1,
  );
  const sourceHeight = Math.max(
    1,
    Number(calibration?.sourceHeight) || Number(displayBounds.height) || 1,
  );
  const scaleX = Number.isFinite(calibration?.scaleX) ? calibration.scaleX : (displayBounds.width / sourceWidth);
  const scaleY = Number.isFinite(calibration?.scaleY) ? calibration.scaleY : (displayBounds.height / sourceHeight);

  let x = coordinate.x;
  let y = coordinate.y;

  if (x > 0 && x <= 1 && y > 0 && y <= 1) {
    x = Math.round(x * sourceWidth);
    y = Math.round(y * sourceHeight);
  } else if (x > 1 && x <= 1000 && y > 1 && y <= 1000) {
    x = Math.round((x / 1000) * sourceWidth);
    y = Math.round((y / 1000) * sourceHeight);
  }

  return {
    x: Math.round(displayBounds.x + (x * scaleX)),
    y: Math.round(displayBounds.y + (y * scaleY)),
  };
}

function resolveTargetDisplay({ pointer, screen }) {
  const displays = screen.getAllDisplays();
  const requestedScreen = Number(pointer?.screenNumber || 0);
  const requestedDisplayId = String(pointer?.displayId || "").trim();

  if (requestedDisplayId) {
    const byId = displays.find((display) => String(display.id) === requestedDisplayId);
    if (byId) {
      return byId;
    }
  }
  if (requestedScreen > 0 && displays[requestedScreen - 1]) {
    return displays[requestedScreen - 1];
  }
  return screen.getPrimaryDisplay();
}

function resolveCalibrationForDisplay({ pointer, targetDisplay, pointerCalibration }) {
  if (!pointerCalibration) {
    return null;
  }
  const requestedScreen = Number(pointer?.screenNumber || 0);
  const requestedDisplayId = String(pointer?.displayId || "").trim();

  if (requestedDisplayId && pointerCalibration.byDisplayId?.[requestedDisplayId]) {
    return pointerCalibration.byDisplayId[requestedDisplayId];
  }
  if (requestedScreen > 0 && pointerCalibration.byScreenNumber?.[requestedScreen]) {
    return pointerCalibration.byScreenNumber[requestedScreen];
  }
  const fallbackDisplayId = String(targetDisplay?.id || "");
  if (fallbackDisplayId && pointerCalibration.byDisplayId?.[fallbackDisplayId]) {
    return pointerCalibration.byDisplayId[fallbackDisplayId];
  }
  return null;
}

function emitPointerTool({ pointer, screen, cursorOverlayWindow, pointerCalibration = null }) {
  if (!pointer?.coordinate || !cursorOverlayWindow || cursorOverlayWindow.isDestroyed()) {
    return null;
  }

  const targetDisplay = resolveTargetDisplay({ pointer, screen });
  const displayBounds = targetDisplay.bounds;
  const calibration = resolveCalibrationForDisplay({
    pointer,
    targetDisplay,
    pointerCalibration,
  });
  const scaled = normalizeCoordinate(pointer.coordinate, displayBounds, calibration);
  const overlayBounds = cursorOverlayWindow.getBounds();
  const payload = {
    ...pointer,
    scaledX: typeof scaled?.x === "number" ? scaled.x - overlayBounds.x : undefined,
    scaledY: typeof scaled?.y === "number" ? scaled.y - overlayBounds.y : undefined,
    screenNumber: Number(pointer?.screenNumber || 0) || null,
  };

  cursorOverlayWindow.setAlwaysOnTop(true, "screen-saver", 1);
  if (typeof cursorOverlayWindow.moveTop === "function") {
    cursorOverlayWindow.moveTop();
  }
  cursorOverlayWindow.show();
  cursorOverlayWindow.webContents.send("show-cursor-at", payload);
  return payload;
}

module.exports = {
  emitPointerTool,
  normalizeCoordinate,
  resolveCalibrationForDisplay,
  resolveTargetDisplay,
};
