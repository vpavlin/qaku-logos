// Stable per-install device id. It is the HLC `dev` tiebreak AND the SDS channel
// `senderId`; distinct from the session secret. Persisted in SecureStore so it
// survives restarts (give the hub and each client distinct ids so wire traffic
// is attributable and you don't mistake your own echo for a peer's).
import * as SecureStore from "expo-secure-store";

let cached: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  let id = await SecureStore.getItemAsync("qaku-device-id");
  if (!id) {
    id = "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    await SecureStore.setItemAsync("qaku-device-id", id);
  }
  cached = id;
  return id;
}
