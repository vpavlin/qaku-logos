// Config plugin: make react-native-background-actions' foreground service legal on
// Android 14 (targetSdk 34). It requires (a) the FOREGROUND_SERVICE_DATA_SYNC permission
// and (b) android:foregroundServiceType="dataSync" ON the service element — the library
// ships the <service> without a type, so we merge the attribute in. Also POST_NOTIFICATIONS
// for the local-notification alerts (Android 13+).
const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

const SERVICE = "com.asterinet.react.bgactions.RNBackgroundActionsTask";

module.exports = function withForegroundService(config) {
  config = AndroidConfig.Permissions.withPermissions(config, [
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
    "android.permission.POST_NOTIFICATIONS",
  ]);
  config = withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.service = app.service || [];
    let svc = app.service.find((s) => s.$ && s.$["android:name"] === SERVICE);
    if (!svc) { svc = { $: { "android:name": SERVICE } }; app.service.push(svc); }
    svc.$["android:foregroundServiceType"] = "dataSync";
    svc.$["android:exported"] = "false";
    return cfg;
  });
  return config;
};
