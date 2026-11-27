// The contract against the real exe.dev. Opt-in (SBX_LIVE=1): it creates and
// removes VMs in the account's pool, with the sbx key or EXE_TOKEN.
import { test } from "node:test";
import type { KindSpec } from "../src/provider.ts";
import { exeFactory } from "../src/providers/exe.ts";
import { providerContract } from "./contract.ts";

const kind: KindSpec = {
  name: "live",
  provider: "exe",
  egress: "all",
  cpu: 1,
  memory: 2,
  integrations: [],
  tags: [],
  env: { SBX_CONTRACT: "kind" },
};

if (process.env.SBX_LIVE === "1") {
  providerContract("exe.dev live", async () => ({ provider: exeFactory({}, { id: "exe", env: process.env }), kind }), {
    timeoutMs: 15 * 60_000,
  });
} else {
  test("exe.dev live contract", { skip: "set SBX_LIVE=1 to run against exe.dev" }, () => {});
}
