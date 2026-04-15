import { createTaskWidgetController } from "./widget/task-widget.js";

const controller = createTaskWidgetController({
  api: window.openguider,
});

window.addEventListener("DOMContentLoaded", () => {
  controller.init();
});