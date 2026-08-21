// OverlayServer implementation. See overlay_server.h for why this is a
// hand-rolled QTcpServer rather than QHttpServer.
#include "overlay_server.h"
#include "overlay_assets.h"

#include <QByteArray>
#include <QHostAddress>
#include <QTcpServer>
#include <QTcpSocket>

namespace {

// A request line plus headers must fit in this. Anything larger is not a browser
// source asking for an overlay, so the connection is dropped rather than buffered.
constexpr int kMaxRequestBytes = 8 * 1024;

std::string httpResponse(const char* status, const char* contentType, const std::string& body)
{
    std::string out;
    out.reserve(body.size() + 256);
    out += "HTTP/1.1 ";
    out += status;
    out += "\r\nContent-Type: ";
    out += contentType;
    out += "\r\nContent-Length: ";
    out += std::to_string(body.size());
    // No Access-Control-Allow-Origin. OBS loads the page same-origin and does not
    // need CORS; sending "*" would let any website the host happens to visit read
    // their private Q&A back off loopback.
    out += "\r\nCache-Control: no-store\r\n"
           "X-Content-Type-Options: nosniff\r\n"
           "Connection: close\r\n\r\n";
    out += body;
    return out;
}

void sendAndClose(QTcpSocket* sock, const std::string& response)
{
    sock->write(response.data(), static_cast<qint64>(response.size()));
    sock->flush();
    sock->disconnectFromHost();
}

}  // namespace

OverlayServer::OverlayServer(PayloadFn payload) : m_payload(std::move(payload)) {}

OverlayServer::~OverlayServer() { stop(); }

bool OverlayServer::start(unsigned short port)
{
    stop();
    m_err.clear();

    auto* tcp = new QTcpServer();
    // LOOPBACK ONLY. QHostAddress::Any would put the session's questions on the
    // LAN; the overlay is unauthenticated by design because OBS cannot send a
    // bearer token, so the bind address IS the access control.
    if (!tcp->listen(QHostAddress::LocalHost, port)) {
        m_err = tcp->errorString().toStdString();
        delete tcp;
        return false;
    }

    m_tcp = tcp;
    m_port = tcp->serverPort();
    // The server itself is the context object, so the connection dies with it and
    // this class needs no Q_OBJECT.
    QObject::connect(tcp, &QTcpServer::newConnection, tcp, [this] { onNewConnection(); });
    return true;
}

void OverlayServer::stop()
{
    if (!m_tcp) return;
    m_tcp->close();
    m_tcp->deleteLater();
    m_tcp = nullptr;
    m_port = 0;
}

void OverlayServer::onNewConnection()
{
    while (m_tcp && m_tcp->hasPendingConnections()) {
        QTcpSocket* sock = m_tcp->nextPendingConnection();
        if (!sock) continue;
        QObject::connect(sock, &QTcpSocket::readyRead, sock, [this, sock] { onReadable(sock); });
        QObject::connect(sock, &QTcpSocket::disconnected, sock, &QTcpSocket::deleteLater);
    }
}

void OverlayServer::onReadable(QTcpSocket* sock)
{
    QByteArray buf = sock->property("qakuBuf").toByteArray();
    buf += sock->readAll();
    if (buf.size() > kMaxRequestBytes) {
        sock->abort();
        return;
    }

    // Wait for the end of the header block. Only the request line is parsed; there
    // is no body handling because every route is a GET.
    const int end = buf.indexOf("\r\n\r\n");
    if (end < 0) {
        sock->setProperty("qakuBuf", buf);
        return;
    }
    sock->setProperty("qakuBuf", QByteArray());

    const QByteArray line = buf.left(buf.indexOf('\r'));
    const QList<QByteArray> parts = line.split(' ');
    if (parts.size() < 2) {
        sendAndClose(sock, httpResponse("400 Bad Request", "text/plain; charset=utf-8", "bad request"));
        return;
    }

    std::string path = parts[1].toStdString();
    const auto q = path.find('?');
    if (q != std::string::npos) path.erase(q);   // query params are read client-side

    serve(sock, parts[0].toStdString(), path);
}

void OverlayServer::serve(QTcpSocket* sock, const std::string& method, const std::string& path)
{
    if (method != "GET" && method != "HEAD") {
        sendAndClose(sock, httpResponse("405 Method Not Allowed", "text/plain; charset=utf-8", "method not allowed"));
        return;
    }

    if (path == "/" || path == "/index.html") {
        sendAndClose(sock, httpResponse("200 OK", "text/html; charset=utf-8", qaku::overlay::kIndexHtml));
        return;
    }

    if (path == "/overlay.json") {
        // m_payload returns the REDUCED projection, never the module snapshot -
        // the snapshot carries `secret`/`shareUri`, i.e. write access to the Q&A.
        const std::string body = m_payload ? m_payload() : std::string("{}");
        sendAndClose(sock, httpResponse("200 OK", "application/json; charset=utf-8", body));
        return;
    }

    sendAndClose(sock, httpResponse("404 Not Found", "text/plain; charset=utf-8", "not found"));
}
