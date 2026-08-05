{
  description = "QAKU engine + sync CORE module (event-log Q&A engine + crypto + delivery); headless hub AND the desktop ui backend.";

  inputs = {
    # Same pinned SDK rev + channel-capable delivery_module as module/flake.nix,
    # so the hub and the desktop/mobile peers build against ONE SDK (avoids the
    # cross-module IPC skew documented in the basecamp/mobile skills). This is the
    # channel-API-capable delivery + the daemon-CLI-compatible builder rev used by
    # the KYM reference; re-pin to the rev your installed Basecamp was built on.
    delivery_module.url = "github:logos-co/logos-delivery-module/feat-add-channel-api-support";
    logos-module-builder.url = "github:logos-co/logos-module-builder/afe4430ee6eb";
    delivery_module.inputs.logos-module-builder.follows = "logos-module-builder";
  };

  # mkLogosModule (not mkLogosQmlModule): a headless core module — no QML view,
  # the plugin glue is generated from src/qaku_core_impl.h (universal authoring).
  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
