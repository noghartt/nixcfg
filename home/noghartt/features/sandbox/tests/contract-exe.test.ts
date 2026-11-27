import type { KindSpec } from "../src/provider.ts";
import { exeProvider } from "../src/providers/exe.ts";
import { providerContract } from "./contract.ts";
import { fakeExe } from "./fake-exe-client.ts";

const kind: KindSpec = {
  name: "dev",
  provider: "exe",
  egress: "all",
  cpu: 2,
  memory: 4,
  integrations: [],
  tags: [],
  env: { SBX_CONTRACT: "kind" },
};

providerContract("exe.dev on a fake client", async () => {
  const client = await fakeExe();
  return { provider: exeProvider({ client: async () => client }), kind, cleanup: client.cleanup };
});
