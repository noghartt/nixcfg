import assert from "node:assert/strict";
import { test } from "node:test";

test("the library exports load, with exe.dev registered", async () => {
  const lib = await import("../src/index.ts");
  assert.ok(lib.registeredProviders().includes("exe"));
  for (const name of ["Sbx", "loadConfig", "parseConfig", "reap", "exeProvider", "UnsupportedError", "NotFoundError", "quote", "createSandbox", "pullBranches", "archiveBranches", "busy"])
    assert.ok(name in lib, name);
});
