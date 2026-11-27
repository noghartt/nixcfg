// Built-in providers, registered once for the library and the CLI alike.
import { exeFactory } from "./providers/exe.ts";
import { registerProvider } from "./registry.ts";

registerProvider("exe", exeFactory);
