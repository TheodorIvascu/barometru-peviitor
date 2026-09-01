"use strict";
/** Keyboard input: digit tabs, arrows, q/r/? plus Ctrl+C cleanup. Works on TTY and piped stdin. */
const readline = require("readline");

/**
 * setupKeyboard(handlers)
 * handlers: { onTab(n), onPrev(), onNext(), onQuit(), onRefresh(), onHelp(), onNormalize() }
 * returns teardown() function.
 */
function setupKeyboard(handlers) {
  const stdin = process.stdin;
  readline.emitKeypressEvents(stdin);
  const isTTY = !!stdin.isTTY;
  if (isTTY && stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const onKeypress = (str, key) => {
    if (!key) key = {};
    if (key.ctrl && key.name === "c") return handlers.onQuit && handlers.onQuit();
    if (key.name === "q") return handlers.onQuit && handlers.onQuit();
    if (key.name === "r") return handlers.onRefresh && handlers.onRefresh();
    if (str === "?" || key.name === "?") return handlers.onHelp && handlers.onHelp();
    if (key.name === "n") return handlers.onNormalize && handlers.onNormalize();
    if (key.name === "left" || key.name === "up") return handlers.onPrev && handlers.onPrev();
    if (key.name === "right" || key.name === "down") return handlers.onNext && handlers.onNext();
    if (str && /^[1-3]$/.test(str)) return handlers.onTab && handlers.onTab(Number(str));
  };

  stdin.on("keypress", onKeypress);

  function teardown() {
    stdin.removeListener("keypress", onKeypress);
    if (isTTY && stdin.setRawMode) {
      try {
        stdin.setRawMode(false);
      } catch {}
    }
  }

  return teardown;
}

module.exports = { setupKeyboard };
