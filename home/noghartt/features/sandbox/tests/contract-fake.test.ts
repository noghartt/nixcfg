import type { KindSpec } from "../src/provider.ts";
import { providerContract } from "./contract.ts";
import { fakeProvider } from "../src/testing.ts";

const kind: KindSpec = { name: "dev", provider: "fake", egress: "all", integrations: [], tags: [], env: { SBX_CONTRACT: "kind" } };

providerContract("in-memory fake", async () => {
  const provider = await fakeProvider();
  return { provider, kind, cleanup: provider.cleanup };
});
