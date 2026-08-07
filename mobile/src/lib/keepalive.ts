// "Keep alive": an Android foreground service (ongoing notification) that keeps the app
// process — and thus the embedded Waku node + the Sessions manager's listener/timers —
// running while any Q&A is STARRED. Without it Android kills the node when backgrounded,
// so a starred Q&A wouldn't receive (or notify about) new questions in the background.
import BackgroundService from "react-native-background-actions";
import { sessions } from "./sessions";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The long-running task. It doesn't need to DO the syncing (the manager's own listener +
// timers keep working because this service keeps the JS thread alive) — it just stays
// resident and nudges a resync every so often so starred Q&As stay fresh.
const task = async () => {
  // eslint-disable-next-line no-constant-condition
  while (BackgroundService.isRunning()) {
    try { await sessions.resync(true); } catch { /* */ }
    await sleep(30000);
  }
};

// Reconcile the service with the number of starred Q&As: run it (or update its text) when
// >0, stop it when 0.
export async function updateKeepAlive(count: number) {
  const options: any = {
    taskName: "qakuSync",
    taskTitle: "QAKU",
    taskDesc: `Keeping ${count} Q&A${count === 1 ? "" : "s"} synced`,
    taskIcon: { name: "ic_launcher", type: "mipmap" },
    color: "#ffc533",
    linkingURI: "qaku://",
    foregroundServiceType: ["dataSync"],
  };
  try {
    if (count > 0) {
      if (BackgroundService.isRunning()) await BackgroundService.updateNotification({ taskDesc: options.taskDesc });
      else await BackgroundService.start(task, options);
    } else if (BackgroundService.isRunning()) {
      await BackgroundService.stop();
    }
  } catch { /* device may deny the FG service — best-effort */ }
}
