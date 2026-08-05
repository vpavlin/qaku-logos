// withSplashColor — define the splashscreen_background color.
//
// expo prebuild's default Android template writes res/drawable/splashscreen.xml
// referencing @color/splashscreen_background, but with no expo-splash-screen
// module and no `splash` config in app.json, that color is never written to
// colors.xml → `assembleRelease` fails at AAPT with "resource
// color/splashscreen_background not found". android/ is regenerated on every
// prebuild, so this must be a config plugin (not a hand-edit of res/).
const { withAndroidColors, AndroidConfig } = require("@expo/config-plugins");

const COLOR = "#0f1115"; // QAKU app background

module.exports = (config) =>
  withAndroidColors(config, (cfg) => {
    cfg.modResults = AndroidConfig.Colors.assignColorValue(cfg.modResults, {
      name: "splashscreen_background",
      value: COLOR,
    });
    return cfg;
  });
