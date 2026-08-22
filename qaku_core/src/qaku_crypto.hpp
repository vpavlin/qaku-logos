#pragma once
// QAKU session crypto (C++/OpenSSL) - byte-parity with packages/sync/src/crypto.mjs.
//   K            = HKDF-SHA256(S, salt="qaku-pair-v1")
//   contentTopic = "/qaku/1/" + hex(HMAC-SHA256(K,"qaku/topic/v1|"+epoch)[0..15]) + "/proto"
//   Ke           = HKDF-SHA256(K, info="qaku/payload/v1")
//   wire payload = nonce(12) || ChaCha20-Poly1305(Ke, nonce, plaintext, aad=topic) || tag(16)
// ASCII-only. OpenSSL is declared in metadata.json (build+runtime) and CMake.
#include <string>
#include <vector>
#include <cstdint>
#include <stdexcept>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/kdf.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

namespace qaku {
using Bytes = std::vector<uint8_t>;

struct Identity { Bytes secret, K, Ke, fpBytes; std::string fingerprint; };

inline std::string toHex(const uint8_t* b, size_t n) {
    static const char* H = "0123456789abcdef"; std::string s; s.reserve(n*2);
    for (size_t i=0;i<n;i++){ s+=H[b[i]>>4]; s+=H[b[i]&15]; } return s;
}

inline Bytes hkdfSha256(const Bytes& ikm, const Bytes& salt, const Bytes& info, size_t len) {
    Bytes out(len);
    EVP_PKEY_CTX* ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, nullptr);
    if (!ctx) throw std::runtime_error("hkdf ctx");
    EVP_PKEY_derive_init(ctx);
    EVP_PKEY_CTX_set_hkdf_md(ctx, EVP_sha256());
    EVP_PKEY_CTX_set1_hkdf_salt(ctx, salt.data(), (int)salt.size());
    EVP_PKEY_CTX_set1_hkdf_key(ctx, ikm.data(), (int)ikm.size());
    EVP_PKEY_CTX_add1_hkdf_info(ctx, info.data(), (int)info.size());
    size_t outlen = len;
    if (EVP_PKEY_derive(ctx, out.data(), &outlen) <= 0) { EVP_PKEY_CTX_free(ctx); throw std::runtime_error("hkdf derive"); }
    EVP_PKEY_CTX_free(ctx); out.resize(outlen); return out;
}

inline Bytes hmacSha256(const Bytes& key, const std::string& msg) {
    unsigned int len=0; Bytes out(32);
    HMAC(EVP_sha256(), key.data(), (int)key.size(), (const uint8_t*)msg.data(), msg.size(), out.data(), &len);
    out.resize(len); return out;
}

inline Bytes sha256(const Bytes& b) { Bytes out(32); SHA256(b.data(), b.size(), out.data()); return out; }
inline Bytes strBytes(const std::string& s){ return Bytes(s.begin(), s.end()); }

inline Identity deriveIdentity(const Bytes& secret) {
    if (secret.size()!=32) throw std::runtime_error("qaku session secret must be 32 bytes");
    Identity id; id.secret = secret;
    id.K  = hkdfSha256(secret, strBytes("qaku-pair-v1"), {}, 32);
    id.Ke = hkdfSha256(id.K, {}, strBytes("qaku/payload/v1"), 32);
    Bytes h = sha256(id.K); id.fpBytes = Bytes(h.begin(), h.begin()+3);
    id.fingerprint = toHex(id.fpBytes.data(), 3);
    return id;
}

inline std::string topicFor(const Identity& id, int epoch=0) {
    Bytes t = hmacSha256(id.K, std::string("qaku/topic/v1|") + std::to_string(epoch));
    return std::string("/qaku/1/") + toHex(t.data(), 16) + "/proto";
}

// Deterministic 12-byte nonce from a seal id (ADR 0011). Byte-identical to loam-sync
// crypto.hpp nonceFor(), packages/sync and the phone: pass an immutable event's id so a
// re-seal is byte-identical and the fleet store dedups it (fixes store bloat + cold-start
// truncation). Ephemeral control frames keep a random nonce (a fresh send is never collapsed).
inline Bytes nonceFor(const Identity& id, const std::string& eventId) {
    Bytes n = hmacSha256(id.Ke, std::string("qaku/nonce/v1|") + eventId);
    n.resize(12);
    return n;
}

// Autoshard (RFC 51 gen-0) for a content topic "/app/version/name/enc": the pubsub
// shard the fleet actually routes on. shard = uint64BE(sha256(app||version)[24..32])
// % count. logos.dev cluster 2 has 8 shards. mobile + desktop derive the same topic
// for a session, so this must match on both sides; if not, they never meet.
inline int shardFor(const std::string& contentTopic, int count = 8) {
    // parse the first two segments: /app/version/...
    size_t a = contentTopic.find('/', 0); if (a == std::string::npos) return -1;
    size_t b = contentTopic.find('/', a + 1); if (b == std::string::npos) return -1;
    size_t c = contentTopic.find('/', b + 1); if (c == std::string::npos) return -1;
    std::string app = contentTopic.substr(a + 1, b - a - 1);
    std::string ver = contentTopic.substr(b + 1, c - b - 1);
    Bytes in = strBytes(app); { Bytes v = strBytes(ver); in.insert(in.end(), v.begin(), v.end()); }
    Bytes h = sha256(in);
    uint64_t val = 0; for (int i = 24; i < 32; i++) val = (val << 8) | h[i]; // big-endian last 8 bytes
    return (int)(val % (uint64_t)count);
}

// seal -> nonce(12) || ciphertext || tag(16). Deterministic nonce derived from eventId
// (ADR 0011): re-sealing the same immutable event is byte-identical → the store dedups it.
inline Bytes seal(const Identity& id, const std::string& eventId, const Bytes& plaintext, const std::string& topic) {
    Bytes nonce = nonceFor(id, eventId);
    EVP_CIPHER_CTX* c = EVP_CIPHER_CTX_new();
    EVP_EncryptInit_ex(c, EVP_chacha20_poly1305(), nullptr, nullptr, nullptr);
    EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_SET_IVLEN, 12, nullptr);
    EVP_EncryptInit_ex(c, nullptr, nullptr, id.Ke.data(), nonce.data());
    int len=0; Bytes aad = strBytes(topic);
    EVP_EncryptUpdate(c, nullptr, &len, aad.data(), (int)aad.size());
    Bytes ct(plaintext.size());
    EVP_EncryptUpdate(c, ct.data(), &len, plaintext.data(), (int)plaintext.size());
    int total=len; EVP_EncryptFinal_ex(c, ct.data()+len, &len); total+=len; ct.resize(total);
    Bytes tag(16); EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_GET_TAG, 16, tag.data());
    EVP_CIPHER_CTX_free(c);
    Bytes out; out.reserve(12+ct.size()+16);
    out.insert(out.end(), nonce.begin(), nonce.end());
    out.insert(out.end(), ct.begin(), ct.end());
    out.insert(out.end(), tag.begin(), tag.end());
    return out;
}

// open - throws on a bad tag (wrong key / tampered / wrong topic).
inline Bytes open(const Identity& id, const Bytes& sealed, const std::string& topic) {
    if (sealed.size() < 28) throw std::runtime_error("sealed too short");
    Bytes nonce(sealed.begin(), sealed.begin()+12);
    Bytes tag(sealed.end()-16, sealed.end());
    Bytes ct(sealed.begin()+12, sealed.end()-16);
    EVP_CIPHER_CTX* c = EVP_CIPHER_CTX_new();
    EVP_DecryptInit_ex(c, EVP_chacha20_poly1305(), nullptr, nullptr, nullptr);
    EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_SET_IVLEN, 12, nullptr);
    EVP_DecryptInit_ex(c, nullptr, nullptr, id.Ke.data(), nonce.data());
    int len=0; Bytes aad = strBytes(topic);
    EVP_DecryptUpdate(c, nullptr, &len, aad.data(), (int)aad.size());
    Bytes pt(ct.size());
    EVP_DecryptUpdate(c, pt.data(), &len, ct.data(), (int)ct.size());
    int total=len;
    EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_SET_TAG, 16, tag.data());
    int ok = EVP_DecryptFinal_ex(c, pt.data()+len, &len); total+=len;
    EVP_CIPHER_CTX_free(c);
    if (ok <= 0) throw std::runtime_error("aead tag verification failed");
    pt.resize(total); return pt;
}

} // namespace qaku
