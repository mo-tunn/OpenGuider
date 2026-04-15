async function captureScreenTool({
  captureAllScreens,
  forceFresh = false,
  maxAgeMs = 900,
} = {}) {
  return captureAllScreens({ forceFresh, maxAgeMs });
}

module.exports = {
  captureScreenTool,
};
