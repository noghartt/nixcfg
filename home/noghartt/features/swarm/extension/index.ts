import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLeader } from "./leader.ts";
import { registerMember } from "./member.ts";

export default function swarm(pi: ExtensionAPI) {
	if (process.env.SWARM_ROLE === "member") registerMember(pi);
	else registerLeader(pi);
}
