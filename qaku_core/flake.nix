{
  description = "QAKU engine + sync CORE module (event-log Q&A engine + crypto + delivery); headless hub AND the desktop ui backend.";

  inputs = {
    # port/0.3: builder 0.3.1 (Basecamp 0.3.x). qaku_core moves sealed bytes through the loam_core
    # FACADE, now on UPSTREAM delivery v0.3.0 (loam-basecamp port/0.3).
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.3.1";
    loam_core.url = "github:vpavlin/loam-basecamp/7ec67c43c9357e787945eb731388c5dc89d31b7c?dir=core";
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
