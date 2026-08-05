import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

// QAKU pure-QML view. It NEVER folds or merges - all logic is in qaku_core. It
// polls the core's snapshot() action on a Timer (events are not reliably
// delivered to QML across Basecamp versions) and renders the returned JSON.
// Mutations call the core and re-render from the call's own fresh return.
Rectangle {
    id: root
    anchors.fill: parent
    color: "#0f1115"
    property string stateJson: "{}"
    property var st: ({})

    function callCore(m, a) {
        if (typeof logos === "undefined" || !logos.callModule) return "";
        return String(logos.callModule("qaku_core", m, a || []));
    }
    // The bridge may return raw JSON or a quoted/escaped JSON string - accept both;
    // unwrap up to twice. Reject an {"error":...} host response.
    function asState(raw) {
        var s = String(raw || "").trim();
        for (var i = 0; i < 2 && s.charAt(0) === '"'; i++) { try { s = String(JSON.parse(s)).trim(); } catch (e) { return null; } }
        if (s.charAt(0) !== "{") return null;
        var o; try { o = JSON.parse(s); } catch (e) { return null; }
        return (o && o.error === undefined) ? o : null;
    }
    // Multi-instance guard: never let an empty-state poll blank a populated view.
    function eventCountOf(o) { return (o && o.eventCount) ? o.eventCount : 0; }
    function apply(o) {
        if (!o) return;
        if (eventCountOf(o) === 0 && eventCountOf(root.st) > 0) return;
        root.st = o; root.stateJson = JSON.stringify(o);
    }
    function refresh() { apply(asState(callCore("snapshot", []))); }
    function mutate(m, a) { apply(asState(callCore(m, a))); }

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

    property bool hasSession: root.st.session !== undefined && root.st.session !== null
    property bool isAdmin: {
        if (!root.st.admins || !root.st.deviceId) return false;
        for (var i = 0; i < root.st.admins.length; i++) if (root.st.admins[i] === root.st.deviceId) return true;
        return false;
    }

    ColumnLayout {
        anchors.fill: parent; anchors.margins: 16; spacing: 12

        // Header
        RowLayout {
            Layout.fillWidth: true
            ColumnLayout {
                Layout.fillWidth: true
                Text { text: root.hasSession ? (root.st.session.title || "Untitled session") : "QAKU"; color: "#f5f7fa"; font.pixelSize: 22; font.bold: true }
                Text {
                    text: root.hasSession
                        ? ((root.st.session.enabled ? "Open" : "Closed") + "  -  " + (root.st.questionCount || 0) + " questions  -  fp " + (root.st.fingerprint || ""))
                        : (root.st.status || "");
                    color: "#8b93a7"; font.pixelSize: 12
                }
            }
            Button {
                visible: !root.hasSession; text: "New session"
                onClicked: root.mutate("createSession", ["Town Hall", "Ask me anything"])
            }
            Button {
                visible: root.hasSession && root.isAdmin
                text: (root.hasSession && root.st.session.enabled) ? "Close" : "Open"
                onClicked: root.mutate("setConfig", [JSON.stringify({ enabled: !root.st.session.enabled })])
            }
        }

        // Ask a question
        RowLayout {
            Layout.fillWidth: true; visible: root.hasSession
            TextField {
                id: qField; Layout.fillWidth: true; placeholderText: "Ask a question..."
                color: "#f5f7fa"; background: Rectangle { color: "#1a1e27"; radius: 8 }
            }
            Button { text: "Ask"; enabled: qField.text.length > 0
                onClicked: { root.mutate("addQuestion", [qField.text]); qField.text = ""; } }
        }

        // Questions list
        ListView {
            Layout.fillWidth: true; Layout.fillHeight: true; clip: true; spacing: 8
            model: root.st.questions ? root.st.questions : []
            delegate: Rectangle {
                width: ListView.view.width
                color: modelData.moderated ? "#241a1a" : "#161a22"; radius: 10
                border.color: modelData.acceptedAnswerId ? "#2a7d5f" : "#232838"; border.width: 1
                implicitHeight: col.implicitHeight + 20
                ColumnLayout {
                    id: col; anchors.fill: parent; anchors.margins: 10; spacing: 6
                    RowLayout {
                        Layout.fillWidth: true
                        Button {
                            text: "^ " + (modelData.upvotes || 0)
                            onClicked: root.mutate("upvoteQuestion", [modelData.id, "true"])
                        }
                        Text { Layout.fillWidth: true; wrapMode: Text.Wrap; color: modelData.moderated ? "#7a6060" : "#e7ebf3"; text: (modelData.moderated ? "[hidden] " : "") + modelData.content }
                        Button { visible: root.isAdmin; text: modelData.moderated ? "Show" : "Hide"
                            onClicked: root.mutate("moderate", [modelData.id, modelData.moderated ? "false" : "true"]) }
                    }
                    Repeater {
                        model: modelData.answers ? modelData.answers : []
                        delegate: RowLayout {
                            Layout.fillWidth: true; Layout.leftMargin: 16
                            Text { text: modelData.accepted ? "[accepted]" : "->"; color: "#2a9d76"; font.pixelSize: 12 }
                            Text { Layout.fillWidth: true; wrapMode: Text.Wrap; color: "#b9c1d4"; text: modelData.content }
                        }
                    }
                    RowLayout {
                        visible: root.isAdmin; Layout.leftMargin: 16
                        TextField { id: ans; Layout.fillWidth: true; placeholderText: "Answer..."; color: "#f5f7fa"; background: Rectangle { color: "#1a1e27"; radius: 6 } }
                        Button { text: "Answer"; enabled: ans.text.length > 0
                            onClicked: { root.mutate("postAnswer", [modelData.id, ans.text]); ans.text = ""; } }
                    }
                }
            }
        }

        // Polls
        Repeater {
            model: root.st.polls ? root.st.polls : []
            delegate: Rectangle {
                Layout.fillWidth: true; color: "#141824"; radius: 10; implicitHeight: pcol.implicitHeight + 16
                property var poll: modelData
                ColumnLayout {
                    id: pcol; anchors.fill: parent; anchors.margins: 10; spacing: 4
                    Text { text: poll.question + (poll.active ? "" : "  (closed)") + "  -  " + (poll.votes || 0) + " votes"; color: "#f5f7fa"; font.bold: true }
                    Repeater {
                        model: poll.options ? poll.options : []
                        delegate: RowLayout {
                            Layout.fillWidth: true
                            property var opt: modelData
                            Button { text: opt.title; enabled: poll.active
                                onClicked: root.mutate("votePoll", [poll.id, opt.id]) }
                            Text { Layout.fillWidth: true; color: "#8b93a7"
                                text: (poll.tally && poll.tally[opt.id] !== undefined) ? ("" + poll.tally[opt.id]) : "0" }
                        }
                    }
                }
            }
        }
    }
}
