/**
 * Kept as the import path the components already use. The state itself lives in
 * `agentConsole.tsx`, mounted once in the root layout so it survives navigation.
 */
export {
  useAgentConsole,
  AgentConsoleProvider,
  type ConnectionState,
  type RunStatus,
} from "./agentConsole";
