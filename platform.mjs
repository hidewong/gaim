import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { posix, win32 } from "node:path";

export function chromeCandidates({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (env.GAIM_CHROME) return [env.GAIM_CHROME];
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      posix.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ];
  }
  if (platform === "win32") {
    return [
      env.PROGRAMFILES && win32.join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      env["PROGRAMFILES(X86)"] && win32.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/google-chrome",
  ];
}

export function systemChromePath(options = {}) {
  const candidates = chromeCandidates(options);
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

export function localSocketPath({
  platform = process.platform,
  env = process.env,
  temporaryDirectory,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  username,
} = {}) {
  if (env.GAIM_SOCKET) return env.GAIM_SOCKET;
  if (platform === "win32") {
    const owner = String(username ?? env.USERNAME ?? safeUsername()).replace(/[^a-zA-Z0-9_.-]/g, "-");
    return `\\\\.\\pipe\\gaim-${owner}`;
  }
  return posix.join(env.XDG_RUNTIME_DIR ?? temporaryDirectory, `gaim-${uid ?? "user"}.sock`);
}

function safeUsername() {
  try {
    return userInfo().username;
  } catch {
    return "user";
  }
}
