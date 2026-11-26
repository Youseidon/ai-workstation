/**
 * Shared entry point for the application WebSocket hook. The state lives in
 * `contexts/hydra.tsx`, mounted once so it survives route navigation.
 */
export {
  useHydra,
  HydraProvider,
} from "../contexts/hydra";
export type { ConnectionState, RunStatus } from "@/models/runs";
