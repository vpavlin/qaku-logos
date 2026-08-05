{
  description = "QAKU - Logos Basecamp ui_qml Q&A module (pure QML view over the qaku_core event-log engine)";

  inputs = {
    # Same pinned SDK rev + delivery_module the core builds against, so the view,
    # core, and delivery all build against ONE SDK (avoids cross-module IPC skew).
    delivery_module.url = "github:logos-co/logos-delivery-module/feat-add-channel-api-support";
    logos-module-builder.url = "github:logos-co/logos-module-builder/afe4430ee6eb";
    delivery_module.inputs.logos-module-builder.follows = "logos-module-builder";
    # The QAKU engine/sync CORE module - this ui module is a thin view over it.
    qaku_core.url = "path:../qaku_core";
    qaku_core.inputs.logos-module-builder.follows = "logos-module-builder";
    qaku_core.inputs.delivery_module.follows = "delivery_module";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
