#pragma once
// OverlayServer - a minimal loopback HTTP/1.1 GET server that publishes the
// current Q&A as a transparent HTML page for an OBS Browser Source.
//
// Deliberately NOT a QObject subclass. qaku_core has no Q_OBJECT anywhere (the
// module is Qt-free by design: nlohmann::json + std::string, with QTimer the one
// Qt type it touches), and adding one would pull an AUTOMOC requirement into a
// build that has never needed it. This class OWNS a QTcpServer and binds lambdas
// with that server as the connect() context object, which needs no moc.
//
// Threading: the server is constructed from onContextReady(), so it lives on the
// module's event-loop thread and newConnection/readyRead fire on that SAME thread
// as publishState() and m_hubTimer. There is no handler thread and therefore no
// cross-thread access to the module's state (the failure mode that the
// module-http-surface-thread-safety skill documents: shared QString/container
// tearing that SIGSEGVs ~20s later, in unrelated code).
//
// Qt HttpServer is avoided on purpose: it is a separate nixpkgs derivation that
// the Basecamp runtime does not ship (macOS Basecamp has none at all), so it
// would need the library bundled into the .lgx and would cost cross-platform
// buildability. Qt6::Network arrives transitively via Qt6::RemoteObjects, which
// the SDK already requires.
#include <functional>
#include <string>

class QTcpServer;
class QTcpSocket;

class OverlayServer {
public:
    // Returns the reduced overlay JSON. Injected so this class never sees the
    // module's snapshot (which carries the session secret) - see serve().
    using PayloadFn = std::function<std::string()>;

    explicit OverlayServer(PayloadFn payload);
    ~OverlayServer();

    OverlayServer(const OverlayServer&) = delete;
    OverlayServer& operator=(const OverlayServer&) = delete;

    // Binds 127.0.0.1 on the given port. False on failure; lastError() says why.
    bool start(unsigned short port);
    void stop();

    bool running() const { return m_tcp != nullptr; }
    unsigned short port() const { return m_port; }
    std::string lastError() const { return m_err; }

private:
    void onNewConnection();
    void onReadable(QTcpSocket* sock);
    void serve(QTcpSocket* sock, const std::string& method, const std::string& path);

    QTcpServer* m_tcp = nullptr;
    PayloadFn m_payload;
    std::string m_err;
    unsigned short m_port = 0;
};
