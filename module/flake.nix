{
  description = "QAKU - Logos Basecamp ui_qml Q&A module (pure QML view over the qaku_core event-log engine)";

  inputs = {
    # port/0.3: builder 0.3.1 — the same builder as qaku_core and loam_core (one SDK).
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.3.1";
    # The QAKU engine/sync CORE module — this ui module is a thin view over it.
    qaku_core.url = "github:vpavlin/qaku-logos/377692db4e12f102a4c6625379f6e1f384f70010?dir=qaku_core";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
