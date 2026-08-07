// Local notifications for new questions in STARRED Q&As. Paired with the foreground
// service (keepalive.ts) so they fire even when the app is backgrounded — that's the
// whole point (be told about a new question without the app open).
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

let inited = false;
export let lastNotifyError = "";

// Call once at startup. onTap(topicHash) opens that Q&A when a notification is tapped.
export async function initNotifications(onTap: (topicHash: string) => void) {
  if (inited) return;
  inited = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
  try { await Notifications.requestPermissionsAsync(); } catch { /* */ }
  if (Platform.OS === "android") {
    try {
      await Notifications.setNotificationChannelAsync("qaku", {
        name: "Q&A updates",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    } catch { /* */ }
  }
  Notifications.addNotificationResponseReceivedListener((resp) => {
    const h = resp.notification.request.content.data?.topicHash as string | undefined;
    if (h) onTap(h);
  });
}

export async function notifyQuestion(topicHash: string, title: string, body: string) {
  // trigger:null = fire immediately (default channel). Most compatible way to actually show.
  await Notifications.scheduleNotificationAsync({
    content: { title: title || "New question", body: body || "", data: { topicHash }, sound: "default" },
    trigger: null,
  }).catch((e) => { lastNotifyError = String(e?.message || e); });
}
