{
  description = "QAKU engine + sync CORE module (event-log Q&A engine + crypto + delivery); headless hub AND the desktop ui backend.";

  inputs = {
    # qaku_core now depends on the loam_core FACADE (not delivery_module directly): it moves
    # sealed bytes through loam_core, which owns the delivery node (+ future ble_mesh). One
    # module-builder across all of them (loam_core's delivery follows it too) = one SDK ABI.
    loam_core.url = "github:vpavlin/loam-basecamp?dir=core";
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.2.6";
    loam_core.inputs.logos-module-builder.follows = "logos-module-builder";
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
