export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

type AgentMessageLike = {
  role?: string;
  stopReason?: string;
};

export function shouldAutoExitOnAgentEnd(
  userTookOver: boolean,
  messages: AgentMessageLike[] | undefined,
): boolean {
  if (userTookOver) return false;

  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}
