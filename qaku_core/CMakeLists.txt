cmake_minimum_required(VERSION 3.14)
project(QakuCorePlugin LANGUAGES CXX)
if(DEFINED ENV{LOGOS_MODULE_BUILDER_ROOT})
    include($ENV{LOGOS_MODULE_BUILDER_ROOT}/cmake/LogosModule.cmake)
elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/cmake/LogosModule.cmake")
    include(cmake/LogosModule.cmake)
else()
    message(FATAL_ERROR "LogosModule.cmake not found")
endif()
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/metadata.json" METADATA_JSON)
string(JSON MODULE_NAME GET ${METADATA_JSON} name)
find_package(OpenSSL REQUIRED)
# Qt6::Network only. It is part of qtbase and already present (the SDK's
# logos_find_qt() requires Qt6::RemoteObjects, which links Network transitively),
# so this needs no nix.packages entry and no flake re-pin. Qt6::HttpServer would:
# it is a separate derivation the Basecamp runtime does not ship at all on macOS.
find_package(Qt6 REQUIRED COMPONENTS Network)
logos_module(
    NAME ${MODULE_NAME}
    SOURCES
        src/qaku_core_impl.h
        src/qaku_core_impl.cpp
        src/qaku_engine.hpp
        src/qaku_crypto.hpp
        src/qaku_identity.hpp
        src/qaku_wire_std.hpp
        src/qaku_persist_std.hpp
        src/qrcodegen.hpp
        src/qrcodegen.cpp
        src/overlay_server.h
        src/overlay_server.cpp
        src/overlay_assets.h
    INCLUDE_DIRS src
    FIND_PACKAGES OpenSSL
    LINK_LIBRARIES OpenSSL::Crypto Qt6::Network
)
