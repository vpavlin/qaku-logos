import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

import Logos.Theme
import Logos.Controls

// QAKU pure-QML view. It NEVER folds or merges - all logic is in qaku_core. It
// polls the core's snapshot() action on a Timer (events are not reliably
// delivered to QML across Basecamp versions) and renders the returned JSON.
// Mutations call the core and re-render from the call's own fresh return.
//
// Styling uses the official Logos design system (Logos.Theme + Logos.Controls),
// consumed exactly like perun/module/src/qml/Main.qml - no hardcoded colours or
// spacing, no hand-rolled QtQuick.Controls.
Item {
    id: root
    anchors.fill: parent

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

    readonly property bool hasSession: root.st.session !== undefined && root.st.session !== null
    readonly property bool sessionOpen: hasSession && root.st.session.enabled !== false
    readonly property string secret: root.st.secret || ""
    readonly property string fingerprint: root.st.fingerprint || ""
    readonly property var questions: root.st.questions ? root.st.questions : []
    readonly property var polls: root.st.polls ? root.st.polls : []
    readonly property bool isAdmin: {
        if (!root.st.admins || !root.st.deviceId) return false;
        for (var i = 0; i < root.st.admins.length; i++) if (root.st.admins[i] === root.st.deviceId) return true;
        return false;
    }

    // ---- toast (mutation errors surfaced instead of swallowed) ----
    property string toastText: ""
    Timer { id: toastTimer; interval: 3200; onTriggered: root.toastText = "" }
    function toast(t) { root.toastText = t; toastTimer.restart(); }
    function act(m, a, err) { if (!root.mutate(m, a)) root.toast(err || "Update qaku_core - action failed"); }

    Rectangle { anchors.fill: parent; color: Theme.palette.background }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Theme.spacing.large
        spacing: Theme.spacing.medium

        // ================= HEADER =================
        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.spacing.medium

            ColumnLayout {
                Layout.fillWidth: true
                spacing: Theme.spacing.tiny
                LogosText {
                    text: root.hasSession ? (root.st.session.title || "Untitled session") : "QAKU"
                    color: Theme.palette.text
                    font.pixelSize: Theme.typography.panelTitleText
                    font.weight: Theme.typography.weightBold
                }
                LogosText {
                    text: root.hasSession
                        ? ((root.sessionOpen ? "Open" : "Closed") + "   -   " + root.questions.length
                            + (root.questions.length === 1 ? " question" : " questions")
                            + (root.fingerprint ? "   -   fp " + root.fingerprint : ""))
                        : (root.st.status || "Local-first Q&A")
                    color: root.hasSession ? (root.sessionOpen ? Theme.palette.success : Theme.palette.textTertiary) : Theme.palette.textSecondary
                    font.pixelSize: Theme.typography.secondaryText
                }
            }

            LogosButton {
                visible: !root.hasSession
                text: "New session"
                implicitWidth: 150; implicitHeight: 40
                onClicked: root.act("createSession", ["Town Hall", "Ask me anything"], "Could not create session")
            }
            LogosButton {
                visible: root.hasSession && root.isAdmin
                text: root.sessionOpen ? "Close session" : "Open session"
                implicitWidth: 150; implicitHeight: 40
                onClicked: root.act("setConfig", [JSON.stringify({ enabled: !root.sessionOpen })], "Could not change session")
            }
        }

        // ================= SHARE (pairing secret) =================
        // The session secret hex IS the pairing code - meant to be shared so a
        // phone/peer joins the SAME derived topic. Selectable + one-click copy.
        Rectangle {
            visible: root.hasSession && root.secret.length > 0
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
                    text: "Share this session"
                    color: Theme.palette.text
                    font.pixelSize: Theme.typography.subtitleText
                    font.weight: Theme.typography.weightMedium
                }
                LogosText {
                    Layout.fillWidth: true
                    text: "Share this secret to let a phone or peer join. They paste it into the QAKU app and sync the same session - keep it private, anyone with it can join."
                    color: Theme.palette.textSecondary
                    font.pixelSize: Theme.typography.secondaryText
                    wrapMode: Text.WordWrap
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.small
                    Rectangle {
                        Layout.fillWidth: true
                        radius: Theme.spacing.radiusSmall
                        color: Theme.palette.surfaceRecessed
                        border.color: Theme.palette.borderHairline
                        border.width: 1
                        implicitHeight: Math.max(40, secretEdit.implicitHeight + 2 * Theme.spacing.small)
                        TextEdit {
                            id: secretEdit
                            anchors.left: parent.left; anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.leftMargin: Theme.spacing.small; anchors.rightMargin: Theme.spacing.small
                            text: root.secret
                            readOnly: true; selectByMouse: true; persistentSelection: true
                            wrapMode: TextEdit.WrapAnywhere
                            color: Theme.palette.text
                            selectionColor: Theme.palette.primary
                            font.family: "monospace"
                            font.pixelSize: Theme.typography.secondaryText
                        }
                    }
                    LogosButton {
                        text: "Copy"
                        implicitWidth: 92; implicitHeight: 40
                        onClicked: { secretEdit.selectAll(); secretEdit.copy(); secretEdit.deselect(); root.toast("Secret copied - share it to let a peer join"); }
                    }
                }
            }
        }

        // ================= ASK A QUESTION =================
        RowLayout {
            visible: root.hasSession
            Layout.fillWidth: true
            spacing: Theme.spacing.small
            LogosTextField {
                id: qField
                Layout.fillWidth: true
                implicitHeight: 40
                placeholderText: root.sessionOpen ? "Ask a question..." : "Session is closed"
                enabled: root.sessionOpen
            }
            LogosButton {
                text: "Ask"
                implicitWidth: 92; implicitHeight: 40
                enabled: root.sessionOpen && qField.text.length > 0
                onClicked: { root.act("addQuestion", [qField.text], "Could not add question"); qField.text = ""; }
            }
        }

        // ================= QUESTIONS =================
        ListView {
            id: qList
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: Theme.spacing.small
            model: root.questions

            LogosText {
                anchors.centerIn: parent
                visible: root.hasSession && qList.count === 0
                text: "No questions yet - be the first to ask"
                color: Theme.palette.textTertiary
                font.pixelSize: Theme.typography.primaryText
            }

            delegate: Rectangle {
                width: qList.width
                radius: Theme.spacing.radiusMedium
                color: modelData.moderated ? Theme.palette.backgroundElevated : Theme.palette.backgroundInset
                border.color: modelData.acceptedAnswerId ? Theme.palette.success : Theme.palette.borderHairline
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

                        // Upvote pill
                        Rectangle {
                            Layout.alignment: Qt.AlignTop
                            implicitWidth: 58; implicitHeight: 52
                            radius: Theme.spacing.radiusSmall
                            color: upMa.containsMouse ? Theme.palette.surfaceRaised : Theme.palette.backgroundSecondary
                            border.color: Theme.palette.borderHairline; border.width: 1
                            ColumnLayout {
                                anchors.centerIn: parent; spacing: 0
                                LogosText { Layout.alignment: Qt.AlignHCenter; text: "▲"; color: Theme.palette.primary; font.pixelSize: 12 }
                                LogosText { Layout.alignment: Qt.AlignHCenter; text: "" + (modelData.upvotes || 0); color: Theme.palette.text; font.pixelSize: 15; font.weight: Theme.typography.weightMedium }
                            }
                            MouseArea { id: upMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                onClicked: root.act("upvoteQuestion", [modelData.id, "true"], "Could not upvote") }
                        }

                        LogosText {
                            Layout.fillWidth: true
                            Layout.alignment: Qt.AlignVCenter
                            text: (modelData.moderated ? "[hidden]  " : "") + (modelData.content || "")
                            color: modelData.moderated ? Theme.palette.textTertiary : Theme.palette.text
                            font.pixelSize: Theme.typography.primaryText
                            wrapMode: Text.WordWrap
                        }

                        LogosButton {
                            visible: root.isAdmin
                            Layout.alignment: Qt.AlignTop
                            text: modelData.moderated ? "Show" : "Hide"
                            implicitWidth: 78; implicitHeight: 36
                            onClicked: root.act("moderate", [modelData.id, modelData.moderated ? "false" : "true"], "Could not moderate")
                        }
                    }

                    // Answers
                    Repeater {
                        model: modelData.answers ? modelData.answers : []
                        delegate: RowLayout {
                            Layout.fillWidth: true
                            Layout.leftMargin: 58 + Theme.spacing.medium
                            spacing: Theme.spacing.small
                            LogosText {
                                text: modelData.accepted ? "✓" : "→"
                                color: modelData.accepted ? Theme.palette.success : Theme.palette.textTertiary
                                font.pixelSize: Theme.typography.secondaryText
                            }
                            LogosText {
                                Layout.fillWidth: true
                                text: modelData.content || ""
                                color: Theme.palette.textSecondary
                                font.pixelSize: Theme.typography.secondaryText
                                wrapMode: Text.WordWrap
                            }
                        }
                    }

                    // Admin: post an answer
                    RowLayout {
                        visible: root.isAdmin
                        Layout.fillWidth: true
                        Layout.leftMargin: 58 + Theme.spacing.medium
                        spacing: Theme.spacing.small
                        LogosTextField {
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

        // ================= POLLS =================
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

        // ================= TOAST =================
        Rectangle {
            visible: root.toastText.length > 0
            Layout.fillWidth: true
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
