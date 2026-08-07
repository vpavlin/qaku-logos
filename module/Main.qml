import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

import Logos.Theme
import Logos.Controls

// QAKU pure-QML view - a multi-session Q&A app with a sidebar. It NEVER folds or
// merges: all logic is in qaku_core. It polls the core's snapshot() action on a
// Timer (events are not reliably delivered to QML across Basecamp versions) and
// renders the returned JSON. Mutations call the core and re-render from the
// call's own fresh return.
//
// Layout mirrors the original qaku web app: a LEFT SIDEBAR (app header, a
// "+ New Q&A" button, a Join-by-secret affordance, a scrollable list of your
// sessions, a Settings area, a status line) + a MAIN PANE showing the selected
// session (header, Share card, Ask box, questions, polls).
//
// Styling uses the official Logos design system (Logos.Theme + Logos.Controls),
// consumed like perun/module/src/qml/Main.qml - no hardcoded colours or spacing,
// no hand-rolled QtQuick.Controls.
Item {
    id: root
    anchors.fill: parent

    property string stateJson: "{}"
    property var st: ({})

    // The host's bundled Logos design system (Basecamp 0.2.0) predates some controls
    // (AppField / LogosCopyableText are "not a type" there). Only LogosText +
    // LogosButton are safe across versions (Perun uses just those). For text inputs we
    // style a plain QtQuick TextField with design TOKENS instead, so it stays on-theme
    // yet loads on every Basecamp version.
    component AppField: TextField {
        color: Theme.palette.text
        placeholderTextColor: Theme.palette.textTertiary
        selectByMouse: true
        leftPadding: Theme.spacing.small
        rightPadding: Theme.spacing.small
        background: Rectangle {
            radius: Theme.spacing.radiusSmall
            color: Theme.palette.surface
            border.color: Theme.palette.border
            border.width: 1
        }
    }
    // Off-screen helper for the Copy button (base QML has no Clipboard type).
    TextEdit { id: clip; visible: false }

    function callCore(m, a) {
        if (typeof logos === "undefined" || !logos.callModule) return "";
        return String(logos.callModule("qaku_core", m, a || []));
    }
    function asState(raw) {
        var s = String(raw || "").trim();
        for (var i = 0; i < 2 && s.charAt(0) === '"'; i++) { try { s = String(JSON.parse(s)).trim(); } catch (e) { return null; } }
        if (s.charAt(0) !== "{") return null;
        var o; try { o = JSON.parse(s); } catch (e) { return null; }
        return (o && o.error === undefined) ? o : null;
    }
    // Multi-instance guard: never let an empty-state poll blank a populated view.
    function eventCountOf(o) { return (o && o.eventCount) ? o.eventCount : 0; }
    function sessionCountOf(o) { return (o && o.sessions) ? o.sessions.length : 0; }
    function apply(o) {
        if (!o) return;
        if (eventCountOf(o) === 0 && sessionCountOf(o) === 0
            && (eventCountOf(root.st) > 0 || sessionCountOf(root.st) > 0)) return;
        root.st = o; root.stateJson = JSON.stringify(o);
    }
    function refresh() { apply(asState(callCore("snapshot", []))); }

    // ---- share QR (qaku_core.shareQr() -> matrix; drawn on a Canvas) ----
    // The host `qr` core is unreachable from pure QML, so the encoder is vendored
    // into qaku_core; here we just paint the returned {n,cells} on a Canvas
    // (Canvas is plain QtQuick - always host-safe, unlike newer design controls).
    property var qrData: null
    property string lastQrSecret: ""
    function buildQr() {
        if (!root.secret) { root.qrData = null; return; }
        try {
            var res = callCore("shareQr", []);
            for (var k = 0; k < 2 && typeof res === "string"; k++) res = JSON.parse(res);
            if (res && res.ok && res.n && res.cells && res.cells.length >= res.n * res.n) {
                root.qrData = { n: res.n, cells: res.cells };
                root.lastQrSecret = root.secret;
                try { qrCanvas.requestPaint(); } catch (e2) {}
                return;
            }
        } catch (e) {}
        root.qrData = null;
    }
    // Rebuild the QR whenever the current session's secret changes — but DEFER it
    // via Qt.callLater. secret first changes during Component.onCompleted (the first
    // snapshot), and a synchronous callCore("shareQr") nested inside load wedges the
    // QML render ("view does not load"). callLater runs it after the view is rendered.
    onSecretChanged: if (root.secret !== root.lastQrSecret) Qt.callLater(root.buildQr)
    function mutate(m, a) {
        var res = asState(callCore(m, a));
        if (res) { apply(res); return true; }
        return false;
    }

    Timer { interval: 2500; running: true; repeat: true; onTriggered: root.refresh() }
    Component.onCompleted: {
        if (typeof logos !== "undefined" && logos.onModuleEvent) logos.onModuleEvent("qaku_core", "stateChanged");
        root.refresh();
    }
    Connections {
        target: (typeof logos !== "undefined") ? logos : null
        ignoreUnknownSignals: true
        function onModuleEventReceived(module, event, data) {
            if (module === "qaku_core") root.apply(asState(data));
        }
    }

    // ---- derived state (current session detail lives at the top level) ----
    readonly property var sessions: root.st.sessions ? root.st.sessions : []
    readonly property string currentId: root.st.currentId || ""
    readonly property bool hasSession: root.st.session !== undefined && root.st.session !== null
    readonly property bool sessionOpen: hasSession && root.st.session.enabled !== false
    readonly property string secret: root.st.secret || ""
    readonly property string shareUri: root.st.shareUri || (root.secret ? ("qaku://join?s=" + root.secret) : "")
    readonly property string fingerprint: root.st.fingerprint || ""
    readonly property var questions: root.st.questions ? root.st.questions : []
    readonly property var polls: root.st.polls ? root.st.polls : []
    readonly property bool isAdmin: {
        if (!root.st.admins || !root.st.deviceId) return false;
        for (var i = 0; i < root.st.admins.length; i++) if (root.st.admins[i] === root.st.deviceId) return true;
        return false;
    }
    function roleColor(r) {
        if (r === "owner") return Theme.palette.primary;
        if (r === "admin") return Theme.palette.info;
        return Theme.palette.textTertiary;
    }

    // ---- join/fetch state: we hold this Q&A's secret+topic (joined) but its state
    // hasn't arrived yet (no session.create folded in). Show a "fetching" indicator
    // instead of the generic empty state, so a join doesn't look like it did nothing.
    readonly property bool awaitingState: root.secret.length === 64 && !root.hasSession
    property bool awaitTimedOut: false
    onAwaitingStateChanged: { root.awaitTimedOut = false; if (root.awaitingState) awaitTimer.restart(); else awaitTimer.stop(); }
    Timer { id: awaitTimer; interval: 25000; onTriggered: root.awaitTimedOut = true }

    // ---- OG qaku palette (match the mobile app: dark + gold + teal) ----
    readonly property color qkBg: "#141415"
    readonly property color qkSurface: "#1a1a1d"
    readonly property color qkSurface2: "#26262b"
    readonly property color qkBorder: "#303035"
    readonly property color qkGold: "#ffc533"
    readonly property color qkTeal: "#50b986"
    readonly property color qkText: "#ffffff"
    readonly property color qkMuted: "#9f9fab"
    function shortAddr(a) { return (a && a.length > 12) ? (a.substring(0, 6) + "…" + a.substring(a.length - 4)) : (a || ""); }
    function hueFor(a) { var h = 0; a = a || ""; for (var i = 2; i < Math.min(a.length, 10); i++) h = (h * 31 + a.charCodeAt(i)) % 360; return h; }
    function timeAgo(ts) {
        if (!ts) return "";
        var mins = Math.floor((Date.now() - ts) / 60000);
        if (mins < 1) return "just now";
        if (mins < 60) return mins + "m";
        var hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + "h";
        var days = Math.floor(hrs / 24);
        if (days < 7) return days + "d";
        return Qt.formatDate(new Date(ts), "d MMM");
    }

    // ---- sort / filter / hidden (OG qaku parity) ----
    property string sortBy: "top"      // top | new | old
    property string filterBy: "all"    // all | unanswered | answered
    property bool hiddenOpen: false
    function answeredOf(q) { return (q.answers && q.answers.length > 0) || (q.acceptedAnswerId ? true : false); }
    readonly property var visibleQuestions: {
        var qs = root.questions.filter(function (x) { return !x.moderated; });
        if (root.filterBy === "unanswered") qs = qs.filter(function (x) { return !root.answeredOf(x); });
        else if (root.filterBy === "answered") qs = qs.filter(function (x) { return root.answeredOf(x); });
        qs = qs.slice();
        if (root.sortBy === "new") qs.sort(function (a, b) { return b.ts - a.ts; });
        else if (root.sortBy === "old") qs.sort(function (a, b) { return a.ts - b.ts; });
        else qs.sort(function (a, b) { return (b.upvotes || 0) - (a.upvotes || 0) || a.ts - b.ts; });
        return qs;
    }
    readonly property var hiddenQuestions: root.questions.filter(function (x) { return x.moderated; })

    // ---- toast (mutation errors surfaced instead of swallowed) ----
    property string toastText: ""
    Timer { id: toastTimer; interval: 3200; onTriggered: root.toastText = "" }
    function toast(t) { root.toastText = t; toastTimer.restart(); }
    function act(m, a, err) { if (!root.mutate(m, a)) root.toast(err || "Action failed - check qaku_core"); }

    Rectangle { anchors.fill: parent; color: root.qkBg }

    RowLayout {
        anchors.fill: parent
        spacing: 0

        // =================================================================
        // ============================ SIDEBAR ============================
        // =================================================================
        Rectangle {
            Layout.preferredWidth: 288
            Layout.minimumWidth: 288
            Layout.fillHeight: true
            color: Theme.palette.backgroundInset
            border.color: Theme.palette.borderHairline
            border.width: 1

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Theme.spacing.medium
                spacing: Theme.spacing.medium

                // ---- app header ----
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.tiny
                    LogosText {
                        text: "QAKU"
                        color: Theme.palette.primary
                        font.pixelSize: Theme.typography.panelTitleText
                        font.weight: Theme.typography.weightBold
                    }
                    LogosText {
                        text: "Local-first Q&A on Logos"
                        color: Theme.palette.textSecondary
                        font.pixelSize: Theme.typography.secondaryText
                    }
                }

                Rectangle { Layout.fillWidth: true; height: 1; color: Theme.palette.borderHairline }

                // ---- + New Q&A ----
                LogosButton {
                    Layout.fillWidth: true
                    implicitHeight: 42
                    text: root.creating ? "Cancel" : "+ New Q&A"
                    onClicked: { root.creating = !root.creating; root.joining = false; }
                }

                // inline create form
                ColumnLayout {
                    visible: root.creating
                    Layout.fillWidth: true
                    spacing: Theme.spacing.small
                    AppField {
                        id: newTitle
                        Layout.fillWidth: true
                        implicitHeight: 38
                        placeholderText: "Q&A title (e.g. Town Hall)"
                    }
                    AppField {
                        id: newDesc
                        Layout.fillWidth: true
                        implicitHeight: 38
                        placeholderText: "Short description (optional)"
                    }
                    LogosButton {
                        Layout.fillWidth: true
                        implicitHeight: 38
                        text: "Create"
                        enabled: newTitle.text.length > 0
                        onClicked: {
                            root.act("createSession", [newTitle.text, newDesc.text], "Could not create session");
                            newTitle.text = ""; newDesc.text = ""; root.creating = false;
                        }
                    }
                }

                // ---- Join by secret ----
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.small
                    LogosButton {
                        Layout.fillWidth: true
                        implicitHeight: 38
                        text: root.joining ? "Cancel join" : "Join a Q&A"
                        onClicked: { root.joining = !root.joining; root.creating = false; }
                    }
                    ColumnLayout {
                        visible: root.joining
                        Layout.fillWidth: true
                        spacing: Theme.spacing.small
                        AppField {
                            id: joinSecret
                            Layout.fillWidth: true
                            implicitHeight: 38
                            placeholderText: "Paste secret (64 hex) or qaku://join link"
                        }
                        LogosButton {
                            Layout.fillWidth: true
                            implicitHeight: 38
                            text: "Join"
                            enabled: joinSecret.text.length >= 64
                            onClicked: {
                                if (root.mutate("joinSession", [joinSecret.text])) { joinSecret.text = ""; root.joining = false; }
                                else root.toast("Could not join - secret must be 64 hex characters");
                            }
                        }
                    }
                }

                // ---- Your Q&As ----
                LogosText {
                    text: "YOUR Q&AS"
                    color: Theme.palette.textTertiary
                    font.pixelSize: Theme.typography.badgeText
                    font.weight: Theme.typography.weightMedium
                }

                ListView {
                    id: sessionList
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    spacing: Theme.spacing.tiny
                    model: root.sessions

                    LogosText {
                        anchors.centerIn: parent
                        width: parent.width - 2 * Theme.spacing.small
                        visible: sessionList.count === 0
                        text: "No Q&As yet.\nCreate one to get started."
                        horizontalAlignment: Text.AlignHCenter
                        wrapMode: Text.WordWrap
                        color: Theme.palette.textTertiary
                        font.pixelSize: Theme.typography.secondaryText
                    }

                    delegate: Rectangle {
                        width: sessionList.width
                        radius: Theme.spacing.radiusSmall
                        implicitHeight: itemCol.implicitHeight + 2 * Theme.spacing.small
                        color: modelData.current ? Theme.palette.overlayOrange
                              : (itemMa.containsMouse ? Theme.palette.backgroundElevated : "transparent")
                        border.color: modelData.current ? Theme.palette.primary : Theme.palette.borderHairline
                        border.width: 1

                        MouseArea {
                            id: itemMa
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.act("switchSession", [modelData.id], "Could not switch session")
                        }

                        ColumnLayout {
                            id: itemCol
                            anchors.left: parent.left; anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.margins: Theme.spacing.small
                            spacing: 2
                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Theme.spacing.small
                                LogosText {
                                    Layout.fillWidth: true
                                    text: modelData.title || "Untitled Q&A"
                                    elide: Text.ElideRight
                                    color: Theme.palette.text
                                    font.pixelSize: Theme.typography.primaryText
                                    font.weight: modelData.current ? Theme.typography.weightBold : Theme.typography.weightRegular
                                }
                                Rectangle {
                                    visible: !modelData.open
                                    radius: Theme.spacing.radiusSmall
                                    color: Theme.palette.backgroundSecondary
                                    implicitWidth: closedLbl.implicitWidth + Theme.spacing.small
                                    implicitHeight: closedLbl.implicitHeight + 4
                                    LogosText { id: closedLbl; anchors.centerIn: parent; text: "closed"; color: Theme.palette.textTertiary; font.pixelSize: Theme.typography.badgeText }
                                }
                            }
                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Theme.spacing.small
                                LogosText {
                                    text: modelData.role
                                    color: root.roleColor(modelData.role)
                                    font.pixelSize: Theme.typography.badgeText
                                    font.weight: Theme.typography.weightMedium
                                }
                                LogosText { text: "-"; color: Theme.palette.textTertiary; font.pixelSize: Theme.typography.badgeText }
                                LogosText {
                                    text: (modelData.questions || 0) + " q"
                                    color: Theme.palette.textTertiary
                                    font.pixelSize: Theme.typography.badgeText
                                }
                                LogosText { text: "-"; color: Theme.palette.textTertiary; font.pixelSize: Theme.typography.badgeText }
                                LogosText {
                                    Layout.fillWidth: true
                                    text: "fp " + (modelData.fingerprint || "")
                                    elide: Text.ElideRight
                                    color: Theme.palette.textTertiary
                                    font.family: "monospace"
                                    font.pixelSize: Theme.typography.badgeText
                                }
                            }
                        }
                    }
                }

                Rectangle { Layout.fillWidth: true; height: 1; color: Theme.palette.borderHairline }

                // ---- Settings: device name ----
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.tiny
                    LogosText {
                        text: "SETTINGS"
                        color: Theme.palette.textTertiary
                        font.pixelSize: Theme.typography.badgeText
                        font.weight: Theme.typography.weightMedium
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Theme.spacing.small
                        AppField {
                            id: deviceField
                            Layout.fillWidth: true
                            implicitHeight: 34
                            placeholderText: "Your device name"
                            text: root.st.deviceId || ""
                        }
                        LogosButton {
                            text: "Save"
                            implicitWidth: 64; implicitHeight: 34
                            enabled: deviceField.text.length > 0 && deviceField.text !== root.st.deviceId
                            onClicked: root.act("setDeviceId", [deviceField.text], "Could not set device name")
                        }
                    }
                }

                // ---- status line ----
                LogosText {
                    Layout.fillWidth: true
                    text: root.st.status || "Starting..."
                    color: Theme.palette.textSecondary
                    font.pixelSize: Theme.typography.badgeText
                    wrapMode: Text.WordWrap
                }

                // ---- transport diagnostics (compare with the phone's Sync card) ----
                ColumnLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: Theme.spacing.small
                    spacing: Theme.spacing.tiny
                    visible: !!root.st.contentTopic
                    LogosText {
                        text: "SYNC / TRANSPORT"
                        color: Theme.palette.textTertiary
                        font.pixelSize: Theme.typography.badgeText
                        font.weight: Theme.typography.weightMedium
                    }
                    LogosText {
                        Layout.fillWidth: true
                        text: "topic " + (root.st.contentTopic || "-")
                        color: Theme.palette.textSecondary
                        font.pixelSize: Theme.typography.badgeText
                        font.family: "monospace"
                        wrapMode: Text.WrapAnywhere
                    }
                    LogosText {
                        Layout.fillWidth: true
                        text: "shard " + (root.st.shard !== undefined ? root.st.shard : "-")
                              + "   /waku/2/rs/2/" + (root.st.shard !== undefined ? root.st.shard : "?")
                        color: Theme.palette.textSecondary
                        font.pixelSize: Theme.typography.badgeText
                        font.family: "monospace"
                    }
                    LogosText {
                        Layout.fillWidth: true
                        text: {
                            var q = root.st.sync || {};
                            return "rxRaw " + (q.rxRaw||0) + "  rxSeen " + (q.rxSeen||0)
                                 + "  rxOpen " + (q.rxOpened||0) + "  rxFail " + (q.rxOpenFail||0)
                                 + "\nrxNew " + (q.rxNew||0) + "  rxDup " + (q.rxDup||0) + "  tx " + (q.txTotal||0);
                        }
                        color: Theme.palette.textSecondary
                        font.pixelSize: Theme.typography.badgeText
                        font.family: "monospace"
                        wrapMode: Text.WordWrap
                    }
                }
            }
        }

        // =================================================================
        // ========================== MAIN PANE ============================
        // =================================================================
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            // empty state — hidden while we're fetching a just-joined Q&A's state.
            ColumnLayout {
                anchors.centerIn: parent
                width: Math.min(parent.width - 2 * Theme.spacing.large, 420)
                visible: !root.hasSession && !root.awaitingState
                spacing: Theme.spacing.small
                LogosText {
                    Layout.alignment: Qt.AlignHCenter
                    text: "Welcome to QAKU"
                    color: Theme.palette.text
                    font.pixelSize: Theme.typography.panelTitleText
                    font.weight: Theme.typography.weightBold
                }
                LogosText {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    text: "Create a new Q&A or join one with a shared secret. Every Q&A syncs peer-to-peer in the background."
                    color: Theme.palette.textSecondary
                    font.pixelSize: Theme.typography.primaryText
                    wrapMode: Text.WordWrap
                }
            }

            // fetching state — joined a Q&A, waiting for a peer to share its history.
            ColumnLayout {
                anchors.centerIn: parent
                width: Math.min(parent.width - 2 * Theme.spacing.large, 440)
                visible: root.awaitingState
                spacing: Theme.spacing.medium
                BusyIndicator {
                    Layout.alignment: Qt.AlignHCenter
                    running: root.awaitingState && !root.awaitTimedOut
                    implicitWidth: 48; implicitHeight: 48
                }
                LogosText {
                    Layout.alignment: Qt.AlignHCenter
                    text: root.awaitTimedOut ? "Still waiting for a peer…" : "Fetching this Q&A…"
                    color: Theme.palette.text
                    font.pixelSize: Theme.typography.panelTitleText
                    font.weight: Theme.typography.weightBold
                }
                LogosText {
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    text: root.awaitTimedOut
                        ? "No peer has shared this Q&A's state yet. Make sure a device that hosts it (the phone or a hub, on the same secret) is online — then it stays put and syncs in the background."
                        : "Joined. Waiting for a device that hosts this Q&A (a phone or hub) to send its questions & answers. This can take a few seconds."
                    color: Theme.palette.textSecondary
                    font.pixelSize: Theme.typography.primaryText
                    wrapMode: Text.WordWrap
                }
                LogosText {
                    visible: root.fingerprint.length > 0
                    Layout.alignment: Qt.AlignHCenter
                    text: "fp " + root.fingerprint
                    color: Theme.palette.textTertiary
                    font.pixelSize: Theme.typography.secondaryText
                }
            }

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Theme.spacing.large
                spacing: Theme.spacing.medium
                visible: root.hasSession

                // ---- session header ----
                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.medium
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: Theme.spacing.tiny
                        LogosText {
                            text: root.hasSession ? (root.st.session.title || "Untitled Q&A") : "QAKU"
                            color: Theme.palette.text
                            font.pixelSize: Theme.typography.panelTitleText
                            font.weight: Theme.typography.weightBold
                        }
                        LogosText {
                            text: (root.sessionOpen ? "Open" : "Closed") + "   -   " + root.questions.length
                                + (root.questions.length === 1 ? " question" : " questions")
                                + (root.fingerprint ? "   -   fp " + root.fingerprint : "")
                            color: root.sessionOpen ? Theme.palette.success : Theme.palette.textTertiary
                            font.pixelSize: Theme.typography.secondaryText
                        }
                    }
                    LogosButton {
                        visible: root.isAdmin
                        text: root.sessionOpen ? "Close" : "Open"
                        implicitWidth: 110; implicitHeight: 40
                        onClicked: root.act("setConfig", [JSON.stringify({ enabled: !root.sessionOpen })], "Could not change session")
                    }
                }

                // ---- Share card (pairing secret) ----
                Rectangle {
                    visible: root.secret.length > 0
                    Layout.fillWidth: true
                    radius: Theme.spacing.radiusMedium
                    color: Theme.palette.backgroundInset
                    border.color: Theme.palette.borderHairline
                    border.width: 1
                    implicitHeight: shareCol.implicitHeight + 2 * Theme.spacing.medium

                    ColumnLayout {
                        id: shareCol
                        anchors.left: parent.left; anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.margins: Theme.spacing.medium
                        spacing: Theme.spacing.small
                        LogosText {
                            text: "Share this Q&A"
                            color: Theme.palette.text
                            font.pixelSize: Theme.typography.subtitleText
                            font.weight: Theme.typography.weightMedium
                        }
                        LogosText {
                            Layout.fillWidth: true
                            text: "Scan the QR with the QAKU phone app, or share the link/secret, to let a phone or peer join and sync the same Q&A. The secret is the password - it encrypts every message end-to-end. Keep it private."
                            color: Theme.palette.textSecondary
                            font.pixelSize: Theme.typography.secondaryText
                            wrapMode: Text.WordWrap
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: Theme.spacing.medium

                            // ---- QR of the share URI (qaku://join?s=<secret>) ----
                            Rectangle {
                                Layout.alignment: Qt.AlignTop
                                implicitWidth: 168
                                implicitHeight: 168
                                radius: Theme.spacing.radiusSmall
                                color: "#ffffff"
                                visible: root.qrData !== null
                                Canvas {
                                    id: qrCanvas
                                    anchors.fill: parent
                                    anchors.margins: 8
                                    onPaint: {
                                        var ctx = getContext("2d"); ctx.reset();
                                        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);
                                        var d = root.qrData; if (!d || !d.n) return;
                                        var cell = width / d.n; ctx.fillStyle = "#000000";
                                        for (var y = 0; y < d.n; y++)
                                            for (var x = 0; x < d.n; x++)
                                                if (d.cells[y * d.n + x])
                                                    ctx.fillRect(Math.floor(x * cell), Math.floor(y * cell), Math.ceil(cell), Math.ceil(cell));
                                    }
                                }
                            }

                            // ---- link + secret + copy buttons ----
                            ColumnLayout {
                                Layout.fillWidth: true
                                Layout.alignment: Qt.AlignTop
                                spacing: Theme.spacing.small
                                LogosText {
                                    text: "Share link"
                                    color: Theme.palette.textTertiary
                                    font.pixelSize: Theme.typography.badgeText
                                    font.weight: Theme.typography.weightMedium
                                }
                                RowLayout {
                                    Layout.fillWidth: true
                                    spacing: Theme.spacing.small
                                    AppField {
                                        id: uriField
                                        Layout.fillWidth: true
                                        readOnly: true
                                        text: root.shareUri
                                    }
                                    LogosButton {
                                        text: "Copy link"
                                        onClicked: { clip.text = root.shareUri; clip.selectAll(); clip.copy(); root.toast("Share link copied - open or scan it on a phone to join"); }
                                    }
                                }
                                LogosText {
                                    text: "Secret (password)"
                                    color: Theme.palette.textTertiary
                                    font.pixelSize: Theme.typography.badgeText
                                    font.weight: Theme.typography.weightMedium
                                }
                                RowLayout {
                                    Layout.fillWidth: true
                                    spacing: Theme.spacing.small
                                    AppField {
                                        id: secretField
                                        Layout.fillWidth: true
                                        readOnly: true
                                        text: root.secret
                                    }
                                    LogosButton {
                                        text: "Copy"
                                        onClicked: { clip.text = root.secret; clip.selectAll(); clip.copy(); root.toast("Secret copied - share it to let a peer join"); }
                                    }
                                }
                            }
                        }
                    }
                }

                // ---- Ask a question ----
                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.small
                    AppField {
                        id: qField
                        Layout.fillWidth: true
                        implicitHeight: 40
                        placeholderText: root.sessionOpen ? "Ask a question..." : "This Q&A is closed"
                        enabled: root.sessionOpen
                    }
                    LogosButton {
                        text: "Ask"
                        implicitWidth: 92; implicitHeight: 40
                        enabled: root.sessionOpen && qField.text.length > 0
                        onClicked: { root.act("addQuestion", [qField.text], "Could not add question"); qField.text = ""; }
                    }
                }

                // ---- sort / filter controls (OG qaku) ----
                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.medium
                    RowLayout {
                        spacing: Theme.spacing.tiny
                        LogosText { text: "Sort"; color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText }
                        Repeater {
                            model: [{ k: "top", l: "Top" }, { k: "new", l: "New" }, { k: "old", l: "Old" }]
                            delegate: Rectangle {
                                radius: 14; implicitHeight: 28; implicitWidth: sortChipTxt.implicitWidth + 22
                                color: modelData.k === root.sortBy ? root.qkGold : root.qkSurface
                                border.color: root.qkBorder; border.width: 1
                                LogosText { id: sortChipTxt; anchors.centerIn: parent; text: modelData.l; font.pixelSize: Theme.typography.secondaryText; color: modelData.k === root.sortBy ? root.qkBg : root.qkMuted }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.sortBy = modelData.k }
                            }
                        }
                    }
                    Item { Layout.fillWidth: true }
                    RowLayout {
                        spacing: Theme.spacing.tiny
                        LogosText { text: "Show"; color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText }
                        Repeater {
                            model: [{ k: "all", l: "All" }, { k: "unanswered", l: "Unanswered" }, { k: "answered", l: "Answered" }]
                            delegate: Rectangle {
                                radius: 14; implicitHeight: 28; implicitWidth: filterChipTxt.implicitWidth + 22
                                color: modelData.k === root.filterBy ? root.qkGold : root.qkSurface
                                border.color: root.qkBorder; border.width: 1
                                LogosText { id: filterChipTxt; anchors.centerIn: parent; text: modelData.l; font.pixelSize: Theme.typography.secondaryText; color: modelData.k === root.filterBy ? root.qkBg : root.qkMuted }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.filterBy = modelData.k }
                            }
                        }
                    }
                }

                // ---- Questions ----
                ListView {
                    id: qList
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    spacing: Theme.spacing.small
                    model: root.visibleQuestions

                    LogosText {
                        anchors.centerIn: parent
                        visible: qList.count === 0
                        text: root.questions.length === 0 ? "No questions yet - be the first to ask" : "No questions match this filter"
                        color: Theme.palette.textTertiary
                        font.pixelSize: Theme.typography.primaryText
                    }

                    // ---- collapsed Hidden section (moderated questions) ----
                    footer: Column {
                        width: qList.width
                        spacing: Theme.spacing.small
                        topPadding: Theme.spacing.medium
                        visible: root.hiddenQuestions.length > 0
                        Rectangle { width: parent.width; height: 1; color: root.qkBorder }
                        Item {
                            width: parent.width; height: 34
                            LogosText { anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter
                                text: (root.hiddenOpen ? "▾" : "▸") + "  Hidden (" + root.hiddenQuestions.length + ")"
                                color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText; font.weight: Theme.typography.weightMedium }
                            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.hiddenOpen = !root.hiddenOpen }
                        }
                        Repeater {
                            model: root.hiddenOpen ? root.hiddenQuestions : []
                            delegate: Rectangle {
                                width: qList.width; radius: Theme.spacing.radiusSmall
                                color: root.qkSurface; border.color: root.qkBorder; border.width: 1; opacity: 0.65
                                implicitHeight: hcol.implicitHeight + 2 * Theme.spacing.small
                                Column {
                                    id: hcol
                                    anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: Theme.spacing.small
                                    spacing: 3
                                    LogosText { width: parent.width; text: modelData.content || ""; color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText; wrapMode: Text.WordWrap }
                                    Row {
                                        width: parent.width; spacing: Theme.spacing.small
                                        LogosText { text: root.shortAddr(modelData.author); color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText }
                                        Item { width: parent.width - 160; height: 1 }
                                        LogosText { visible: root.isAdmin; text: "Unhide"; color: root.qkTeal; font.pixelSize: Theme.typography.secondaryText
                                            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.act("moderate", [modelData.id, "false"], "Could not unhide") }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    delegate: Rectangle {
                        width: qList.width
                        radius: Theme.spacing.radiusMedium
                        color: root.qkSurface
                        border.color: modelData.acceptedAnswerId ? root.qkTeal : root.qkBorder
                        border.width: 1
                        implicitHeight: qcol.implicitHeight + 2 * Theme.spacing.medium

                        ColumnLayout {
                            id: qcol
                            anchors.left: parent.left; anchors.right: parent.right
                            anchors.top: parent.top; anchors.margins: Theme.spacing.medium
                            spacing: Theme.spacing.small

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Theme.spacing.medium

                                Rectangle {
                                    Layout.alignment: Qt.AlignTop
                                    implicitWidth: 58; implicitHeight: 52
                                    radius: Theme.spacing.radiusSmall
                                    color: upMa.containsMouse ? root.qkSurface2 : root.qkBg
                                    border.color: root.qkBorder; border.width: 1
                                    ColumnLayout {
                                        anchors.centerIn: parent; spacing: 0
                                        LogosText { Layout.alignment: Qt.AlignHCenter; text: "▲"; color: root.qkGold; font.pixelSize: 11 }
                                        LogosText { Layout.alignment: Qt.AlignHCenter; text: "" + (modelData.upvotes || 0); color: root.qkText; font.pixelSize: 15; font.weight: Theme.typography.weightMedium }
                                    }
                                    MouseArea { id: upMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                        onClicked: root.act("upvoteQuestion", [modelData.id, "true"], "Could not upvote") }
                                }

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    Layout.alignment: Qt.AlignVCenter
                                    spacing: Theme.spacing.tiny
                                    LogosText {
                                        Layout.fillWidth: true
                                        text: (modelData.moderated ? "🚫  " : "") + (modelData.content || "")
                                        color: modelData.moderated ? root.qkMuted : root.qkText
                                        font.pixelSize: Theme.typography.primaryText
                                        wrapMode: Text.WordWrap
                                    }
                                    RowLayout {
                                        spacing: Theme.spacing.tiny
                                        Rectangle {
                                            implicitWidth: 18; implicitHeight: 18; radius: 9
                                            color: Qt.hsla(root.hueFor(modelData.author) / 360, 0.45, 0.32, 1)
                                            LogosText { anchors.centerIn: parent; text: (modelData.author && modelData.author.length > 2) ? modelData.author.charAt(2).toUpperCase() : "?"; color: root.qkText; font.pixelSize: 9; font.weight: Theme.typography.weightBold }
                                        }
                                        LogosText { text: root.shortAddr(modelData.author); color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText }
                                        LogosText { text: "·  " + root.timeAgo(modelData.ts); color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText; opacity: 0.85 }
                                    }
                                }

                                LogosButton {
                                    visible: root.isAdmin
                                    Layout.alignment: Qt.AlignTop
                                    text: modelData.moderated ? "Show" : "Hide"
                                    implicitWidth: 78; implicitHeight: 36
                                    onClicked: root.act("moderate", [modelData.id, modelData.moderated ? "false" : "true"], "Could not moderate")
                                }
                            }

                            Repeater {
                                model: modelData.answers ? modelData.answers : []
                                delegate: RowLayout {
                                    Layout.fillWidth: true
                                    Layout.leftMargin: 58 + Theme.spacing.medium
                                    spacing: Theme.spacing.small
                                    LogosText {
                                        text: modelData.accepted ? "✓" : "↳"
                                        color: modelData.accepted ? root.qkTeal : root.qkMuted
                                        font.pixelSize: Theme.typography.secondaryText
                                    }
                                    LogosText {
                                        Layout.fillWidth: true
                                        text: modelData.content || ""
                                        color: modelData.accepted ? root.qkTeal : "#d8d8e0"
                                        font.pixelSize: Theme.typography.secondaryText
                                        wrapMode: Text.WordWrap
                                    }
                                }
                            }

                            RowLayout {
                                visible: root.isAdmin
                                Layout.fillWidth: true
                                Layout.leftMargin: 58 + Theme.spacing.medium
                                spacing: Theme.spacing.small
                                AppField {
                                    id: ansField
                                    Layout.fillWidth: true
                                    implicitHeight: 36
                                    placeholderText: "Answer..."
                                }
                                LogosButton {
                                    text: "Answer"
                                    implicitWidth: 92; implicitHeight: 36
                                    enabled: ansField.text.length > 0
                                    onClicked: { root.act("postAnswer", [modelData.id, ansField.text], "Could not post answer"); ansField.text = ""; }
                                }
                            }
                        }
                    }
                }

                // ---- Polls ----
                Repeater {
                    model: root.polls
                    delegate: Rectangle {
                        Layout.fillWidth: true
                        radius: Theme.spacing.radiusMedium
                        color: Theme.palette.backgroundInset
                        border.color: Theme.palette.borderHairline; border.width: 1
                        implicitHeight: pcol.implicitHeight + 2 * Theme.spacing.medium
                        property var poll: modelData
                        ColumnLayout {
                            id: pcol
                            anchors.left: parent.left; anchors.right: parent.right
                            anchors.top: parent.top; anchors.margins: Theme.spacing.medium
                            spacing: Theme.spacing.small
                            LogosText {
                                text: poll.question + (poll.active ? "" : "   (closed)") + "   -   " + (poll.votes || 0) + " votes"
                                color: Theme.palette.text
                                font.pixelSize: Theme.typography.primaryText
                                font.weight: Theme.typography.weightMedium
                            }
                            Repeater {
                                model: poll.options ? poll.options : []
                                delegate: RowLayout {
                                    Layout.fillWidth: true
                                    spacing: Theme.spacing.small
                                    property var opt: modelData
                                    LogosButton {
                                        text: opt.title
                                        implicitWidth: 140; implicitHeight: 36
                                        enabled: poll.active
                                        onClicked: root.act("votePoll", [poll.id, opt.id], "Could not vote")
                                    }
                                    LogosText {
                                        Layout.fillWidth: true
                                        color: Theme.palette.textSecondary
                                        font.pixelSize: Theme.typography.secondaryText
                                        text: (poll.tally && poll.tally[opt.id] !== undefined) ? ("" + poll.tally[opt.id]) : "0"
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // ---- toast (overlay, bottom of the main pane) ----
            Rectangle {
                visible: root.toastText.length > 0
                anchors.left: parent.left; anchors.right: parent.right
                anchors.bottom: parent.bottom
                anchors.margins: Theme.spacing.large
                radius: Theme.spacing.radiusSmall
                color: Theme.palette.backgroundSecondary
                border.color: Theme.palette.error; border.width: 1
                implicitHeight: toastLbl.implicitHeight + 2 * Theme.spacing.small
                LogosText {
                    id: toastLbl
                    anchors.left: parent.left; anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.margins: Theme.spacing.medium
                    text: root.toastText
                    color: Theme.palette.error
                    font.pixelSize: Theme.typography.secondaryText
                    wrapMode: Text.WordWrap
                }
            }
        }
    }

    // sidebar UI toggles
    property bool creating: false
    property bool joining: false
}
