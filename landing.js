const modules = [
  {
    title: "Fast Mode",
    description: "Instant answers for quick tasks.",
    meta: ["Low-latency replies", "Uses recent context"],
    icon: "fast",
    priority: "core"
  },
  {
    title: "Planning Mode",
    description: "Step-by-step execution for complex goals.",
    meta: ["Plan + progress view", "Action controls built-in"],
    icon: "planning",
    priority: "core"
  },
  {
    title: "Context History",
    description: "Keeps conversations and task state coherent.",
    meta: ["Session-aware responses", "Recent history memory"],
    icon: "history",
    priority: "core"
  },
  {
    title: "Screen-Aware Guidance",
    description: "Guidance based on what is on screen.",
    meta: ["Screenshot attach", "Coordinate hints"],
    icon: "vision"
  },
  {
    title: "Desktop Task Widget",
    description: "Control tasks without leaving your app.",
    meta: ["Compact floating widget", "Live step status"],
    icon: "widget"
  },
  {
    title: "Voice Input & Output",
    description: "Talk to OpenGuider and hear responses back.",
    meta: ["Streaming STT", "Provider-based TTS"],
    icon: "voice"
  },
  {
    title: "Multi-Provider Models",
    description: "Switch providers and models freely.",
    meta: ["OpenAI, Claude, Gemini, more", "Per-provider model setup"],
    icon: "providers"
  },
  {
    title: "Execution Controls",
    description: "Refine or retry steps when needed.",
    meta: ["Regenerate and recheck", "Request targeted help"],
    icon: "controls"
  }
];

const GITHUB_REPO_URL = "https://github.com/mo-tunn/OpenGuider";
const GITHUB_LATEST_RELEASE_URL = `${GITHUB_REPO_URL}/releases/latest`;
const downloads = [
  { os: "Windows", href: `${GITHUB_LATEST_RELEASE_URL}/download/OpenGuider-windows-latest.exe` },
  { os: "MacOS", href: `${GITHUB_LATEST_RELEASE_URL}/download/OpenGuider-macos-latest.zip` },
  { os: "Linux", href: `${GITHUB_LATEST_RELEASE_URL}/download/OpenGuider-linux-latest.AppImage` }
];

const configureSteps = [
  {
    title: "Provider Setup",
    description: "Open Settings and connect the providers you want to use.",
    checklist: ["Paste API keys for your preferred providers", "Set default model per provider", "Save and run a quick test message"],
    tip: "Tip: start with one provider first, then add others."
  },
  {
    title: "Mode Selection",
    description: "Choose when to use Fast Mode vs Planning Mode.",
    checklist: ["Fast Mode for short, direct asks", "Planning Mode for multi-step goals", "Switch mode from the main panel anytime"],
    tip: "Tip: keep Fast Mode as default for daily quick tasks."
  },
  {
    title: "Voice & Audio",
    description: "Configure speech-to-text and text-to-speech behavior.",
    checklist: ["Select STT backend and language", "Set TTS provider and voice", "Test push-to-talk and playback volume"],
    tip: "Tip: verify mic permissions before testing voice."
  },
  {
    title: "Context & History",
    description: "Tune how much recent context is used during replies.",
    checklist: ["Keep recent conversation history enabled", "Review active session state after long tasks", "Clear history when switching unrelated topics"],
    tip: "Tip: concise history often gives faster, cleaner answers."
  }
];

function createCard(tagName, className) {
  const element = document.createElement(tagName);
  element.className = className;
  return element;
}

function renderModules() {
  const grid = document.getElementById("feature-grid");
  if (!grid) {
    return;
  }

  modules.forEach((item, index) => {
    const card = createCard("article", "feature-card");
    if (index < 2) {
      card.classList.add("feature-card-highlight");
    } else {
      card.classList.add("feature-card-secondary");
    }
    const lineFx = createCard("span", "feature-card-linefx");
    lineFx.setAttribute("aria-hidden", "true");
    const head = createCard("div", "feature-card-head");
    const title = createCard("h3", "feature-card-title");
    const description = createCard("p", "feature-card-description");
    const meta = createCard("ul", "feature-meta-list");
    const divider = createCard("span", "feature-card-divider");

    title.textContent = item.title;
    description.textContent = item.description;

    head.append(title);
    (item.meta || []).slice(0, 2).forEach((entry) => {
      const itemMeta = createCard("li", "");
      itemMeta.textContent = entry;
      meta.appendChild(itemMeta);
    });
    card.append(lineFx, head, description, divider, meta);
    grid.appendChild(card);
  });
}

function renderDownloads() {
  const grid = document.getElementById("hero-download-grid");
  if (!grid) {
    return;
  }

  const iconMarkupByOS = {
    windows: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M2 4.6 11 3.2v8.1H2V4.6zm10 6.7h10V2L12 3.3v8zm-10 1.5H11v8L2 19.4v-6.6zm10 0h10V22l-10-1.4v-7.8z"/>
      </svg>
    `,
    macos: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M16.2 2c.2 1.7-.5 3-1.4 4-.9.9-2.2 1.5-3.4 1.4-.2-1.4.5-2.9 1.3-3.8C13.6 2.6 15 2 16.2 2zm4.1 15.3c-.4.8-.8 1.4-1.2 2-1 1.5-2 3.4-3.7 3.4-1.5 0-2-.9-3.8-.9s-2.4.9-3.8.9c-1.6 0-2.6-1.7-3.7-3.4C1 16.3.3 11.7 2.6 8.8c1.2-1.6 2.8-2.5 4.4-2.5 1.7 0 2.8.9 4.2.9s2.4-.9 4.1-.9c1.4 0 3 .8 4.2 2.2-3.6 2-3 7.3.8 8.8z"/>
      </svg>
    `,
    linux: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <ellipse cx="12" cy="8.8" rx="3.1" ry="3.8" fill="currentColor"/>
        <ellipse cx="12" cy="15.1" rx="4.3" ry="5.2" fill="currentColor"/>
        <ellipse cx="10.9" cy="9.4" rx="0.45" ry="0.55" fill="#0c0c0c"/>
        <ellipse cx="13.1" cy="9.4" rx="0.45" ry="0.55" fill="#0c0c0c"/>
        <path fill="#0c0c0c" d="M11.15 11.15h1.7c-.18.58-.48.93-.85.93-.39 0-.66-.35-.85-.93z"/>
        <ellipse cx="9.15" cy="20" rx="1.55" ry="0.78" fill="currentColor"/>
        <ellipse cx="14.85" cy="20" rx="1.55" ry="0.78" fill="currentColor"/>
      </svg>
    `
  };

  const downloadGlyph = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M11 4h2v8.1l2.8-2.8 1.4 1.4-5.2 5.2-5.2-5.2 1.4-1.4 2.8 2.8V4zm-6 13h14v2H5v-2z"/>
    </svg>
  `;

  downloads.forEach((item, index) => {
    const link = createCard("a", "download-link");
    const osKey = item.os.toLowerCase();
    link.classList.add("download-card");
    link.classList.add(`download-card-${index + 1}`);
    link.classList.add(`download-${osKey}`);
    link.setAttribute("aria-label", `${item.os} Download`);

    const icon = createCard("span", "download-card-icon");
    icon.innerHTML = iconMarkupByOS[osKey] || iconMarkupByOS.windows;

    const osLabel = createCard("span", "download-card-label");
    osLabel.textContent = item.os;

    const downloadIcon = createCard("span", "download-card-download-icon");
    downloadIcon.innerHTML = downloadGlyph;

    link.append(icon, osLabel, downloadIcon);
    link.href = item.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    grid.appendChild(link);
  });
}

function initConfigurePanel() {
  const stepsWrap = document.getElementById("configure-steps");
  const stepIndex = document.getElementById("configure-step-index");
  const stepTitle = document.getElementById("configure-step-title");
  const stepDescription = document.getElementById("configure-step-description");
  const stepList = document.getElementById("configure-step-list");
  const stepTip = document.getElementById("configure-step-tip");
  if (!stepsWrap || !stepIndex || !stepTitle || !stepDescription || !stepList || !stepTip) {
    return;
  }

  const buttons = [];

  function selectStep(nextIndex) {
    const step = configureSteps[nextIndex];
    if (!step) {
      return;
    }

    stepIndex.textContent = `Step ${nextIndex + 1}/${configureSteps.length}`;
    stepTitle.textContent = step.title;
    stepDescription.textContent = step.description;
    stepTip.textContent = step.tip;
    stepList.innerHTML = "";
    step.checklist.forEach((entry) => {
      const item = createCard("li", "");
      item.textContent = entry;
      stepList.appendChild(item);
    });

    buttons.forEach((button, idx) => {
      const isActive = idx === nextIndex;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-selected", String(isActive));
      button.tabIndex = isActive ? 0 : -1;
    });
  }

  configureSteps.forEach((step, index) => {
    const btn = createCard("button", "configure-step-btn");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.innerHTML = `<span>${index + 1}</span><strong>${step.title}</strong>`;
    btn.addEventListener("click", () => selectStep(index));
    stepsWrap.appendChild(btn);
    buttons.push(btn);
  });

  selectStep(0);
}

function testImage(path) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(path);
    img.onerror = () => reject(new Error(`Image not found: ${path}`));
    img.src = path;
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function resolveAssetBase() {
  const candidates = ["./assets", "../renderer/assets"];
  for (const base of candidates) {
    try {
      await testImage(`${base}/logo.png`);
      return base;
    } catch (_error) {
      // Try next base path.
    }
  }
  return "./assets";
}

async function startEyeBlink() {
  const eye = document.getElementById("background-eye-logo");
  if (!eye) {
    return;
  }

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!prefersReducedMotion) {
    document.body.classList.add("intro-block-ui");
  }
  const primaryBase = await resolveAssetBase();
  const fallbackBase = primaryBase === "./assets" ? "../renderer/assets" : "./assets";

  const blinkFrames = [
    `${primaryBase}/logo.png`,
    `${primaryBase}/half-opened.png`,
    `${primaryBase}/full-closed.png`,
    `${primaryBase}/half-opened.png`,
    `${primaryBase}/logo.png`
  ];

  const fallbackFrames = [
    `${fallbackBase}/logo.png`,
    `${fallbackBase}/half-opened.png`,
    `${fallbackBase}/full-closed.png`,
    `${fallbackBase}/half-opened.png`,
    `${fallbackBase}/logo.png`
  ];

  let activeFrames = blinkFrames;

  eye.addEventListener("error", () => {
    activeFrames = fallbackFrames;
    eye.src = fallbackFrames[0];
  });

  function scheduleNextBlink() {
    const nextDelayMs = 3000 + Math.random() * 2800;
    window.setTimeout(() => playFrame(0), nextDelayMs);
  }

  function playFrame(index) {
    if (index >= activeFrames.length) {
      scheduleNextBlink();
      return;
    }
    eye.src = activeFrames[index];
    window.setTimeout(() => playFrame(index + 1), 80);
  }

  async function runIntroSequence() {
    if (prefersReducedMotion) {
      eye.src = activeFrames[0];
      return;
    }
    document.body.classList.add("intro-block-ui");
    document.body.classList.add("intro-active");
    eye.src = activeFrames[2];
    await wait(480);
    eye.src = activeFrames[1];
    await wait(340);
    eye.src = activeFrames[2];
    await wait(280);
    eye.src = activeFrames[1];
    await wait(300);
    eye.src = activeFrames[0];
    document.body.classList.add("intro-flash");
    await wait(980);
    document.body.classList.remove("intro-flash");
    document.body.classList.add("intro-settle");
    document.body.classList.remove("intro-active");
    window.dispatchEvent(new Event("landing-intro-settle"));
    await wait(120);
    document.body.classList.add("content-entering");
    document.body.classList.remove("intro-block-ui");
    await wait(140);
    document.body.classList.add("intro-finished");
    document.body.classList.remove("intro-settle", "content-entering");
    window.dispatchEvent(new Event("landing-intro-finished"));
  }

  await runIntroSequence();
  scheduleNextBlink();
}

async function initLogoFallbacks() {
  const base = await resolveAssetBase();
  const logoPath = `${base}/logo.png`;
  const fallbackPath = base === "./assets" ? "../renderer/assets/logo.png" : "./assets/logo.png";
  const logos = document.querySelectorAll(".js-logo-fallback");
  logos.forEach((logo) => {
    if (!(logo instanceof HTMLImageElement)) {
      return;
    }
    logo.addEventListener("error", () => {
      if (logo.src.includes(fallbackPath)) {
        return;
      }
      logo.src = fallbackPath;
    });
    logo.src = logoPath;
  });
}

function initAICursor() {
  if (window.matchMedia("(pointer: coarse)").matches) {
    return;
  }

  const cursor = document.getElementById("cursor");
  const label = document.getElementById("cursor-label");
  const ripple1 = document.getElementById("ripple1");
  const ripple2 = document.getElementById("ripple2");
  if (!cursor || !label || !ripple1 || !ripple2) {
    return;
  }

  const interactiveSelector = [
    "a",
    "button",
    "[role='button']",
    ".btn",
    ".download-link",
    ".mock-send-btn",
    ".mock-clear-btn",
    ".mock-widget-actions span",
    ".mock-app-actions span"
  ].join(", ");

  let hideTimer = null;
  let hoverTarget = null;
  let rafId = 0;
  let currentX = window.innerWidth / 2;
  let currentY = window.innerHeight / 2;
  let targetX = currentX;
  let targetY = currentY;
  let hasMoved = false;

  function setHoverTarget(nextTarget) {
    if (hoverTarget === nextTarget) {
      return;
    }
    if (hoverTarget) {
      hoverTarget.classList.remove("hover-sync");
    }
    hoverTarget = nextTarget;
    if (hoverTarget) {
      hoverTarget.classList.add("hover-sync");
    }
    cursor.classList.toggle("interactive", Boolean(hoverTarget));
  }

  function animateRipple() {
    ripple1.classList.remove("animate");
    ripple2.classList.remove("animate");
    void ripple1.offsetWidth;
    ripple1.classList.add("animate");
    ripple2.classList.add("animate");
  }

  function setLabelFromTarget(target) {
    if (!(target instanceof Element)) {
      label.textContent = "OpenGuider";
      return;
    }
    const explicitLabel = target.getAttribute("aria-label") || target.getAttribute("title");
    if (explicitLabel) {
      label.textContent = explicitLabel;
      return;
    }
    if (target.matches("a, button, [role='button'], .btn, .download-link, .mock-send-btn, .mock-clear-btn, .mock-widget-actions span, .mock-app-actions span")) {
      const shortText = (target.textContent || "").trim().replace(/\s+/g, " ");
      label.textContent = shortText.slice(0, 28) || "OpenGuider";
      return;
    }
    label.textContent = "OpenGuider";
  }

  function showCursorAt(x, y, target) {
    clearTimeout(hideTimer);

    if (!cursor.classList.contains("visible")) {
      cursor.style.transition = "none";
      cursor.style.left = `${currentX}px`;
      cursor.style.top = `${currentY}px`;
      void cursor.offsetWidth;
      cursor.style.transition = "";
    }

    const interactiveTarget = target instanceof Element ? target.closest(interactiveSelector) : null;
    setHoverTarget(interactiveTarget);
    setLabelFromTarget(target);
    targetX = x;
    targetY = y;
    if (!rafId) {
      rafId = window.requestAnimationFrame(stepCursor);
    }
    cursor.classList.add("visible");
    hasMoved = true;

    hideTimer = window.setTimeout(() => {
      cursor.classList.remove("visible");
      setHoverTarget(null);
    }, 1800);
  }

  function stepCursor() {
    rafId = 0;
    const lerp = cursor.classList.contains("interactive") ? 0.42 : 0.36;
    currentX += (targetX - currentX) * lerp;
    currentY += (targetY - currentY) * lerp;
    cursor.style.left = `${currentX}px`;
    cursor.style.top = `${currentY}px`;
    if (Math.abs(targetX - currentX) > 0.4 || Math.abs(targetY - currentY) > 0.4) {
      rafId = window.requestAnimationFrame(stepCursor);
    }
  }

  window.addEventListener("pointermove", (event) => {
    showCursorAt(event.clientX, event.clientY, event.target);
  });

  window.addEventListener("mousedown", () => {
    animateRipple();
  });

  window.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest(interactiveSelector)) {
      animateRipple();
    }
  });

  window.addEventListener("blur", () => {
    cursor.classList.remove("visible");
    setHoverTarget(null);
  });

  window.addEventListener("mouseleave", () => {
    cursor.classList.remove("visible");
    setHoverTarget(null);
  });

  document.addEventListener("pointerover", (event) => {
    if (!hasMoved) {
      return;
    }
    if (!(event.target instanceof Element)) {
      return;
    }
    const nextTarget = event.target.closest(interactiveSelector);
    setHoverTarget(nextTarget);
  });
}

function initScrollRevealEffects() {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) {
    document.body.classList.add("reveal-active");
    return;
  }

  const sections = Array.from(document.querySelectorAll("main > section"));
  if (!sections.length) {
    return;
  }

  const revealSelectors = [
    "h2",
    ".features-title",
    ".section-lead",
    ".configure-title",
    ".configure-subtitle",
    ".configure-step-btn",
    ".configure-preview",
    ".security-intro",
    ".feature-card",
    ".security-info-block",
    ".security-info-block h3",
    ".security-list li",
    ".security-cta",
    ".footer-inner span"
  ];

  const revealDirections = ["from-up", "from-left", "from-right", "from-up"];
  document.body.classList.add("scroll-reveal-enabled");

  let lastScrollY = window.scrollY;
  let scrollDirection = "down";

  window.addEventListener("scroll", () => {
    const nextY = window.scrollY;
    if (Math.abs(nextY - lastScrollY) > 2) {
      scrollDirection = nextY > lastScrollY ? "down" : "up";
      lastScrollY = nextY;
    }
  }, { passive: true });

  sections.forEach((section, sectionIndex) => {
    section.classList.add("scroll-section");
    const targets = new Set();
    revealSelectors.forEach((selector) => {
      section.querySelectorAll(selector).forEach((element) => targets.add(element));
    });
    if (!targets.size) {
      return;
    }
    let revealIndex = 0;
    targets.forEach((element) => {
      element.classList.add("reveal-item");
      element.classList.add(revealDirections[(revealIndex + sectionIndex) % revealDirections.length]);
      element.style.setProperty("--reveal-delay", `${Math.min(54 * revealIndex, 480)}ms`);
      revealIndex += 1;
    });
  });

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const section = entry.target;
      if (!(section instanceof HTMLElement)) {
        return;
      }
      if (entry.isIntersecting && entry.intersectionRatio >= 0.18) {
        section.dataset.scrollDir = scrollDirection;
        section.classList.add("in-view");
      } else if (entry.intersectionRatio <= 0.06) {
        section.classList.remove("in-view");
        section.dataset.scrollDir = scrollDirection;
      }
    });
  }, {
    threshold: [0, 0.06, 0.18, 0.35],
    rootMargin: "0px 0px -10% 0px"
  });

  sections.forEach((section) => observer.observe(section));

  function activateRevealSystem() {
    if (document.body.classList.contains("reveal-active")) {
      return;
    }
    document.body.classList.add("reveal-active");
  }

  if (document.body.classList.contains("intro-finished")) {
    activateRevealSystem();
  } else {
    window.addEventListener("landing-intro-finished", activateRevealSystem, { once: true });
  }
}

function initHeroEntranceEffects() {
  const hero = document.querySelector(".hero");
  if (!hero) {
    return;
  }

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) {
    document.body.classList.add("hero-entrance-done");
    return;
  }

  document.body.classList.add("hero-entrance-pending");

  function startHeroEntrance() {
    if (document.body.classList.contains("hero-entrance-started")) {
      return;
    }
    document.body.classList.add("hero-entrance-started");
    window.setTimeout(() => {
      document.body.classList.add("hero-entrance-done");
      document.body.classList.remove("hero-entrance-pending");
    }, 3600);
  }

  if (document.body.classList.contains("intro-settle")) {
    window.setTimeout(startHeroEntrance, 0);
    return;
  }

  if (document.body.classList.contains("intro-finished")) {
    window.setTimeout(startHeroEntrance, 0);
  } else if (document.body.classList.contains("intro-active")) {
    window.addEventListener("landing-intro-settle", () => {
      window.setTimeout(startHeroEntrance, 0);
    }, { once: true });
  } else {
    window.addEventListener("landing-intro-finished", () => {
      window.setTimeout(startHeroEntrance, 0);
    }, { once: true });
  }
}

function initHeroScrollMotion() {
  const hero = document.querySelector(".hero");
  if (!hero) {
    return;
  }

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReducedMotion) {
    hero.dataset.scrollDir = "down";
    return;
  }

  document.body.classList.add("hero-scroll-motion-enabled");

  let lastScrollY = window.scrollY;
  let rafId = 0;

  function updateHeroMotion() {
    rafId = 0;
    const nextY = window.scrollY;
    const maxDistance = Math.max(window.innerHeight * 0.78, 460);
    const progress = Math.max(0, Math.min(nextY / maxDistance, 1));
    const scrollDir = nextY > lastScrollY ? "down" : "up";
    hero.dataset.scrollDir = scrollDir;
    hero.classList.toggle("is-scrolled", nextY > 8);
    hero.style.setProperty("--hero-scroll-progress", progress.toFixed(3));
    lastScrollY = nextY;
  }

  function requestUpdate() {
    if (rafId) {
      return;
    }
    rafId = window.requestAnimationFrame(updateHeroMotion);
  }

  updateHeroMotion();
  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate);
}

renderModules();
renderDownloads();
initConfigurePanel();
initHeroEntranceEffects();
initHeroScrollMotion();
startEyeBlink();
initLogoFallbacks();
initAICursor();
initScrollRevealEffects();
