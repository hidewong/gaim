import assert from "node:assert/strict";
import test from "node:test";
import { chromeCandidates, localSocketPath } from "./platform.mjs";

test("Chrome discovery covers Windows, macOS, and Linux without downloading a browser", () => {
  assert.equal(chromeCandidates({ platform: "linux", env: {}, home: "/home/alex" })[0], "/usr/bin/google-chrome");
  assert.equal(
    chromeCandidates({ platform: "darwin", env: {}, home: "/Users/alex" })[0],
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  assert.equal(
    chromeCandidates({
      platform: "win32",
      env: { PROGRAMFILES: "C:\\Program Files" },
      home: "C:\\Users\\alex",
    })[0],
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  );
});

test("an explicit Chrome path always wins", () => {
  assert.deepEqual(chromeCandidates({ env: { GAIM_CHROME: "/custom/chrome" } }), ["/custom/chrome"]);
});

test("local IPC uses a Windows named pipe and a Unix user socket", () => {
  assert.equal(
    localSocketPath({ platform: "win32", env: {}, username: "Alice Smith" }),
    "\\\\.\\pipe\\gaim-Alice-Smith",
  );
  assert.equal(
    localSocketPath({ platform: "linux", env: {}, temporaryDirectory: "/tmp", uid: 1000 }),
    "/tmp/gaim-1000.sock",
  );
});
