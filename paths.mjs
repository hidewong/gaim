import { tmpdir } from "node:os";
import { localSocketPath } from "./platform.mjs";

export function gaimSocketPath() {
  return localSocketPath({ temporaryDirectory: tmpdir() });
}
