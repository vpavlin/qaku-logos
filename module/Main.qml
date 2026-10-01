import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

import Logos.Theme
import Logos.Controls

// QAKU pure-QML view - a multi-session Q&A app with a sidebar. It NEVER folds or
// merges: all logic is in qaku_core. It renders the core's snapshot() JSON, kept
// current by the core's stateChanged push plus a slow safety poll. EVERY module call
// is asynchronous (see call() below - house rule: no blocking calls in QML); mutations
// re-render from their own result (deferred) and then request a fresh snapshot.
//
// Layout mirrors the original qaku web app: a LEFT SIDEBAR (app header, a
// "+ New Q&A" button, a Join-by-secret affordance, a scrollable list of your
// sessions, a Settings area, a status line) + a MAIN PANE showing the selected
// session (header, Share card, a Questions | Polls tab row, then the Ask box + questions
// or the owner/admin New-poll card + poll cards).
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

    // ---- the ONE way this view talks to a module: ALWAYS async (house rule: no blocking
    // calls in QML, ever). A synchronous logos.callModule on the QML thread freezes the whole UI
    // for up to the 20 s IPC timeout whenever qaku_core is busy.
    //   - Newer Basecamp bridges expose callModuleAsync(module, method, args, cb, timeoutMs):
    //     cb receives ONE string (what callModule would return, or {"error":...} incl. timeout).
    //   - Older bridges (Basecamp 0.2.0) lack it: fall back to the sync callModule, but run it
    //     DEFERRED via Qt.callLater (never inside the caller's signal handler) and deliver the
    //     result through the same callback, so every caller is uniformly async.
    // cb is always invoked exactly once, with a string.
    readonly property int callTimeoutMs: 20000
    function hasAsyncBridge() {
        return typeof logos !== "undefined" && logos !== null && typeof logos.callModuleAsync === "function";
    }
    function _deliver(cb, raw) {
        if (!cb) return;
        try { cb(raw === undefined || raw === null ? "" : String(raw)); }
        catch (e) { console.warn("qaku view: callback error: " + e); }
    }
    function callModuleVia(module, method, args, cb) {
        var a = args || [];
        if (typeof logos === "undefined" || logos === null) {
            Qt.callLater(function () { root._deliver(cb, '{"error":"no logos bridge"}'); });
            return;
        }
        if (root.hasAsyncBridge()) {
            try {
                logos.callModuleAsync(module, method, a, function (res) { root._deliver(cb, res); }, root.callTimeoutMs);
            } catch (e) {
                var msg = JSON.stringify({ error: "callModuleAsync threw: " + e });
                Qt.callLater(function () { root._deliver(cb, msg); });
            }
            return;
        }
        // Fallback (old bridge): the only remaining synchronous callModule, deferred out of the
        // caller's handler so a delegate can never be destroyed mid-handler by the result.
        Qt.callLater(function () {
            var raw;
            try { raw = (typeof logos.callModule === "function") ? logos.callModule(module, method, a) : '{"error":"no callModule"}'; }
            catch (e) { raw = JSON.stringify({ error: "callModule threw: " + e }); }
            root._deliver(cb, raw);
        });
    }
    function call(method, args, cb) { root.callModuleVia("qaku_core", method, args, cb); }
    // Human-readable error from a failed call's raw payload (for the toast), or "".
    function errorOf(raw) {
        var s = String(raw || "").trim();
        for (var i = 0; i < 2 && s.charAt(0) === '"'; i++) { try { s = String(JSON.parse(s)).trim(); } catch (e) { break; } }
        if (s.charAt(0) !== "{") return "";
        try { var o = JSON.parse(s); return (o && o.error !== undefined) ? String(o.error) : ""; } catch (e2) { return ""; }
    }
    function asState(raw) {
        var s = String(raw || "").trim();
        for (var i = 0; i < 2 && s.charAt(0) === '"'; i++) { try { s = String(JSON.parse(s)).trim(); } catch (e) { return null; } }
        if (s.charAt(0) !== "{") return null;
        var o; try { o = JSON.parse(s); } catch (e) { return null; }
        return (o && o.error === undefined) ? o : null;
    }
    // Multi-instance guard: an empty state from a core that has not finished loading (status
    // still "Starting...", before onContextReady read the data dir) must not blank a populated
    // view. A READY core's empty state is real - e.g. deleteSession removed the last Q&A - and
    // is applied. A failed call / error never reaches here (asState returns null).
    function eventCountOf(o) { return (o && o.eventCount) ? o.eventCount : 0; }
    function sessionCountOf(o) { return (o && o.sessions) ? o.sessions.length : 0; }
    function coreReady(o) { return !!o && typeof o.status === "string" && o.status.length > 0 && o.status !== "Starting..."; }
    function apply(o) {
        if (!o) return;
        if (eventCountOf(o) === 0 && sessionCountOf(o) === 0 && !coreReady(o)
            && (eventCountOf(root.st) > 0 || sessionCountOf(root.st) > 0)) return;
        root.st = o; root.stateJson = JSON.stringify(o);
    }
    // Snapshot fetch: async, never overlapping. A request while one is in flight is coalesced
    // into ONE follow-up fetch after it returns. A watchdog frees the guard if a bridge ever
    // fails to call back (longer than the IPC timeout), so the poll can never wedge.
    property bool _snapInFlight: false
    property bool _snapAgain: false
    property double _snapStartedAt: 0
    function refresh() {
        if (root._snapInFlight && (Date.now() - root._snapStartedAt) < root.callTimeoutMs + 15000) {
            root._snapAgain = true;
            return;
        }
        root._snapInFlight = true; root._snapAgain = false; root._snapStartedAt = Date.now();
        root.call("snapshot", [], function (raw) {
            root._snapInFlight = false;
            // asState() returns null for a failed call / error / timeout -> nothing applied, so a
            // failure never blanks the view; apply() additionally refuses an empty state from a
            // core that isn't ready yet.
            root._pushState(root.asState(raw));
            if (root._snapAgain) { root._snapAgain = false; Qt.callLater(root.refresh); }
        });
    }

    // ---- share QR (qaku_core.shareQr() -> matrix; drawn on a Canvas) ----
    // The host `qr` core is unreachable from pure QML, so the encoder is vendored
    // into qaku_core; here we just paint the returned {n,cells} on a Canvas
    // (Canvas is plain QtQuick - always host-safe, unlike newer design controls).
    property var qrData: null
    property string lastQrSecret: ""
    function buildQr() {
        if (!root.secret) { root.qrData = null; root.lastQrSecret = ""; return; }
        var want = root.secret;
        root.call("shareQr", [], function (raw) {
            if (root.secret !== want) return;       // session switched meanwhile; a newer build runs
            try {
                var res = raw;
                for (var k = 0; k < 2 && typeof res === "string"; k++) res = JSON.parse(res);
                if (res && res.ok && res.n && res.cells && res.cells.length >= res.n * res.n) {
                    root.qrData = { n: res.n, cells: res.cells };
                    root.lastQrSecret = want;
                    try { qrCanvas.requestPaint(); } catch (e2) {}
                    return;
                }
            } catch (e) {}
            root.qrData = null;
        });
    }
    // Rebuild the QR whenever the current session's secret changes — but DEFER it
    // via Qt.callLater (shareQr itself is async via call(); callLater keeps it out of the
    // load / apply path entirely).
    onSecretChanged: if (root.secret !== root.lastQrSecret) Qt.callLater(root.buildQr)
    // ---- mutations: async, de-duplicated, result applied DEFERRED ----
    // `inflight` maps method -> count of calls in flight (reassigned so bindings like a button's
    // `enabled: !root.isBusy("addQuestion")` re-evaluate); `_inflightKeys` drops an identical
    // call (same method + args) while one is still running - a double-click can't double-submit.
    property var inflight: ({})
    property var _inflightKeys: ({})
    function isBusy(m) { return (root.inflight[m] || 0) > 0; }
    function _mark(m, key, delta) {
        var f = Object.assign({}, root.inflight);
        f[m] = Math.max(0, (f[m] || 0) + delta);
        if (f[m] === 0) delete f[m];
        root.inflight = f;
        var k = Object.assign({}, root._inflightKeys);
        if (delta > 0) k[key] = true; else delete k[key];
        root._inflightKeys = k;
    }
    // mutate(m, a, done): done(ok, errText) is called once. NEVER apply the result synchronously:
    // the caller is usually a delegate's onClicked, and reassigning root.st rebuilds the model and
    // destroys that delegate while its handler is on the stack ("Object destroyed while one of its
    // QML signal handlers is in progress" -> Aborted). The result goes through _pushState
    // (Qt.callLater), and a coalesced snapshot is requested after every mutation. Callbacks must
    // not touch delegate-scoped items (they may be gone by then) - only root-level state.
    // Returns false if an identical call was already in flight (dropped).
    function mutate(m, a, done) {
        var args = a || [];
        var key = m + "\u0001" + JSON.stringify(args);
        if (root._inflightKeys[key]) return false;
        root._mark(m, key, +1);
        root.call(m, args, function (raw) {
            root._mark(m, key, -1);
            var res = root.asState(raw);
            if (res) root._pushState(res);
            root.refresh();
            if (done) {
                try { done(!!res, res ? "" : root.errorOf(raw)); }
                catch (e) { console.warn("qaku view: mutate done error: " + e); }
            }
        });
        return true;
    }

    // Baseline: a slow safety poll (async, in-flight-guarded, coalesced) in case a stateChanged
    // push is dropped. The push (onModuleEventReceived below) is what keeps the view current.
    Timer {
        interval: 6000; running: true; repeat: true
        onTriggered: root.refresh()
    }
    Component.onCompleted: {
        if (typeof logos !== "undefined" && logos.onModuleEvent) logos.onModuleEvent("qaku_core", "stateChanged");
        root.refresh();
    }
    // Deferred, crash-safe state apply. _pendingState holds a PARSED state object (asState output),
    // applied on the next event-loop tick -- NEVER synchronously inside a signal handler (a click's
    // mutate, or a received-message push), where reassigning root.st would destroy the delegate whose
    // handler is still on the stack -> "Object destroyed ... handler in progress" -> Aborted.
    property var _pendingState: undefined
    function _applyPending() {
        if (root._pendingState === undefined) return;
        var o = root._pendingState; root._pendingState = undefined;
        root.apply(o);
    }
    // Every state source (push, poll, mutate result) routes through here: it takes an ALREADY-PARSED
    // object, stashes the latest, and coalesces a burst into one deferred apply. (0.1.23 bug: callers
    // stored a parsed object but _applyPending re-ran asState on it -> null -> the view never updated
    // and clicks "did nothing"; a click's object also clobbered a pushed update -> messages vanished.)
    function _pushState(o) { if (!o) return; root._pendingState = o; Qt.callLater(root._applyPending); }
    Connections {
        target: (typeof logos !== "undefined") ? logos : null
        ignoreUnknownSignals: true
        function onModuleEventReceived(module, event, data) {
            // Defer the apply OUT of this signal handler. Applying synchronously here rebuilds
            // the questions model mid-handler, which can destroy a question delegate while one of
            // ITS signal handlers is still running -> "Object destroyed while one of its QML signal
            // handlers is in progress" -> Aborted. A burst of received messages (each a stateChanged)
            // makes it reliable. Qt.callLater coalesces the burst into a single apply of the latest
            // snapshot on the next tick (same pattern as buildQr; see onSecretChanged above).
            if (module !== "qaku_core") return;
            var o = root.asState(data);
            if (o) root._pushState(o);
            else root.refresh();            // payload-less / unparsable push: fetch (coalesced, async)
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
    // display name (from profile.set fold) if the author set one, else their short address
    function nameOf(a) { var n = root.st.names ? root.st.names[a] : ""; return (n && n.length > 0) ? n : root.shortAddr(a); }
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
    property bool shareOpen: false     // the Share card is collapsed by default (declutter)
    property bool showDiag: false      // the SYNC/TRANSPORT diagnostics are hidden by default
    property bool hiddenOpen: false
    readonly property int onStreamCount: {
        var n = 0, qs = root.st.questions || [];
        for (var i = 0; i < qs.length; i++) if (qs[i].onStream && !qs[i].moderated) n++;
        return n;
    }
    readonly property bool overlayOn: (root.st.overlay && root.st.overlay.enabled) ? true : false
    readonly property string overlayErr: (root.st.overlay && root.st.overlay.error) ? String(root.st.overlay.error) : ""

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
    function act(m, a, err, onOk) {
        root.mutate(m, a, function (ok, detail) {
            if (ok) { if (onOk) onOk(); }
            else root.toast((err || "Action failed - check qaku_core") + (detail ? (" (" + detail + ")") : ""));
        });
    }
    // ---- delete a Q&A (local removal via qaku_core.deleteSession) or a poll (deletePoll, synced),
    // gated by ONE shared confirm overlay; confirmDeleteKind picks which ("session" | "poll") ----
    property string confirmDeleteId: ""
    property string confirmDeleteTitle: ""
    property string confirmDeleteKind: "session"
    function askDelete(id, title) { root.confirmDeleteKind = "session"; root.confirmDeleteId = id || ""; root.confirmDeleteTitle = title || "Untitled Q&A"; }
    function askDeletePoll(id, title) { root.confirmDeleteKind = "poll"; root.confirmDeleteId = id || ""; root.confirmDeleteTitle = title || "Untitled poll"; }
    function doDelete() {
        var id = root.confirmDeleteId; root.confirmDeleteId = "";
        if (id.length === 0) return;
        if (root.confirmDeleteKind === "poll")
            root.act("deletePoll", [id], "Could not delete poll", function () { root.toast("Poll deleted"); });
        else
            root.act("deleteSession", [id], "Could not delete Q&A", function () { root.toast("Q&A deleted"); });
    }

    // ---- polls (qaku_core createPoll / setPollActive / deletePoll / votePoll) ----
    property string paneView: "questions"      // main-pane tab: questions | polls
    // owner/admin may create/close/delete polls. The core's adminGuard checks st.admins (which
    // includes the owner); st.role is the same fact from roleFor - accept either.
    readonly property bool canManagePolls: root.isAdmin || root.st.role === "owner" || root.st.role === "admin"
    // newest first; the core's order is fold order
    readonly property var sortedPolls: root.polls.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); })
    function hasVoted(p) { return !!p && p.myVote !== undefined && p.myVote !== null && p.myVote !== ""; }
    // Visibility rule: counts are shown if results are public, you voted, the poll is closed, or
    // you run the session. Otherwise vote buttons only (+ "Results after you vote"). Counts only -
    // the snapshot never says who voted.
    function pollShowsResults(p) { return !!p && (p.results === "always" || root.hasVoted(p) || !p.active || root.canManagePolls); }
    function pollCount(p, oid) { return (p && p.tally && p.tally[oid] !== undefined) ? (Number(p.tally[oid]) || 0) : 0; }
    function pollMax(p) {
        var m = 0, os = (p && p.options) ? p.options : [];
        for (var i = 0; i < os.length; i++) m = Math.max(m, root.pollCount(p, os[i].id));
        return m;
    }
    function pollOptionTitle(p, oid) {
        var os = (p && p.options) ? p.options : [];
        for (var i = 0; i < os.length; i++) if (os[i].id === oid) return os[i].title;
        return "";
    }
    // New-poll form. The options live in a root-level ListModel; pollOptsRev bumps on every edit so
    // the validation binding re-evaluates (ListModel.setProperty does not notify JS bindings).
    property bool pollFormOpen: false
    property bool pollFormActive: true
    property string pollFormResults: "always"   // always | afterVote
    property int pollOptsRev: 0
    ListModel { id: pollOpts; ListElement { label: "" } ListElement { label: "" } }
    function pollOptionTexts() {
        var out = [];
        for (var i = 0; i < pollOpts.count; i++) { var t = String(pollOpts.get(i).label || "").trim(); if (t.length > 0) out.push(t); }
        return out;
    }
    readonly property string pollFormProblem: {
        void root.pollOptsRev;
        if (pollQuestionField.text.trim().length === 0) return "Enter a question";
        var opts = root.pollOptionTexts();
        if (opts.length < 2) return "Add at least 2 options";
        for (var i = 0; i < opts.length; i++)
            if (opts.indexOf(opts[i]) !== i) return "Options must be different (\"" + opts[i] + "\" is repeated)";
        return "";
    }
    function addPollOpt() { pollOpts.append({ label: "" }); root.pollOptsRev++; }
    function setPollOpt(i, t) { if (i >= 0 && i < pollOpts.count) { pollOpts.setProperty(i, "label", t); root.pollOptsRev++; } }
    function removePollOpt(i) { if (i >= 0 && i < pollOpts.count && pollOpts.count > 2) { pollOpts.remove(i); root.pollOptsRev++; } }
    function resetPollForm() {
        pollTitleField.text = ""; pollQuestionField.text = "";
        pollOpts.clear(); pollOpts.append({ label: "" }); pollOpts.append({ label: "" });
        root.pollFormActive = true; root.pollFormResults = "always"; root.pollOptsRev++;
    }
    function submitPoll() {
        if (root.pollFormProblem !== "") { root.toast(root.pollFormProblem); return; }
        var settings = { results: root.pollFormResults };
        var t = pollTitleField.text.trim();
        if (t.length > 0) settings.title = t;
        root.mutate("createPoll",
                    [pollQuestionField.text.trim(), JSON.stringify(root.pollOptionTexts()),
                     root.pollFormActive ? "true" : "false", JSON.stringify(settings)],
                    function (ok, detail) {
                        if (ok) { root.resetPollForm(); root.pollFormOpen = false; root.toast("Poll created"); }
                        else root.toast("Could not create poll" + (detail ? (" (" + detail + ")") : ""));
                    });
    }

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

                // ---- app header (icon + wordmark) ----
                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.small
                    Image {
                        source: "icon.png"          // bundled sibling of Main.qml in the .lgx
                        sourceSize.width: 44; sourceSize.height: 44
                        Layout.preferredWidth: 44; Layout.preferredHeight: 44
                        fillMode: Image.PreserveAspectFit
                        smooth: true
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: Theme.spacing.tiny
                        LogosText { textFormat: Text.PlainText;
                            text: "QAKU"
                            color: root.qkGold
                            font.pixelSize: Theme.typography.panelTitleText
                            font.weight: Theme.typography.weightBold
                        }
                        LogosText { textFormat: Text.PlainText;
                            text: "Local-first Q&A on Logos"
                            color: Theme.palette.textSecondary
                            font.pixelSize: Theme.typography.secondaryText
                        }
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
                        enabled: newTitle.text.length > 0 && !root.isBusy("createSession")
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
                            text: root.isBusy("joinSession") ? "Joining..." : "Join"
                            enabled: joinSecret.text.length >= 64 && !root.isBusy("joinSession")
                            onClicked: root.act("joinSession", [joinSecret.text],
                                                "Could not join - secret must be 64 hex characters",
                                                function () { joinSecret.text = ""; root.joining = false; })
                        }
                    }
                }

                // ---- Your Q&As ----
                LogosText { textFormat: Text.PlainText;
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

                    LogosText { textFormat: Text.PlainText;
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
                                LogosText { textFormat: Text.PlainText;
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
                                    LogosText { textFormat: Text.PlainText; id: closedLbl; anchors.centerIn: parent; text: "closed"; color: Theme.palette.textTertiary; font.pixelSize: Theme.typography.badgeText }
                                }
                                // Delete this Q&A. Its own MouseArea sits above the row's switch handler.
                                Rectangle {
                                    Layout.preferredWidth: 24; Layout.preferredHeight: 24
                                    radius: 12
                                    color: delMa.containsMouse ? Theme.palette.overlayOrange : "transparent"
                                    border.color: delMa.containsMouse ? Theme.palette.error : Theme.palette.borderHairline
                                    border.width: 1
                                    LogosText { textFormat: Text.PlainText;
                                        anchors.centerIn: parent; text: "×"
                                        color: delMa.containsMouse ? Theme.palette.error : Theme.palette.textTertiary
                                        font.pixelSize: Theme.typography.primaryText
                                    }
                                    MouseArea {
                                        id: delMa; anchors.fill: parent; hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        onClicked: root.askDelete(modelData.id, modelData.title)
                                    }
                                }
                            }
                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Theme.spacing.small
                                LogosText { textFormat: Text.PlainText;
                                    text: modelData.role
                                    color: root.roleColor(modelData.role)
                                    font.pixelSize: Theme.typography.badgeText
                                    font.weight: Theme.typography.weightMedium
                                }
                                LogosText { textFormat: Text.PlainText; text: "-"; color: Theme.palette.textTertiary; font.pixelSize: Theme.typography.badgeText }
                                LogosText { textFormat: Text.PlainText;
                                    text: (modelData.questions || 0) + " q"
                                    color: Theme.palette.textTertiary
                                    font.pixelSize: Theme.typography.badgeText
                                }
                                LogosText { textFormat: Text.PlainText; text: "-"; color: Theme.palette.textTertiary; font.pixelSize: Theme.typography.badgeText }
                                LogosText { textFormat: Text.PlainText;
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

                // ---- Settings: display name + identity ----
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.tiny
                    LogosText { textFormat: Text.PlainText;
                        text: "DISPLAY NAME"
                        color: Theme.palette.textTertiary
                        font.pixelSize: Theme.typography.badgeText
                        font.weight: Theme.typography.weightMedium
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Theme.spacing.small
                        AppField {
                            id: nameField
                            Layout.fillWidth: true
                            implicitHeight: 34
                            placeholderText: "A name people will see (optional)"
                            text: root.st.myName || ""
                        }
                        LogosButton {
                            text: "Save"
                            implicitWidth: 64; implicitHeight: 34
                            enabled: nameField.text !== (root.st.myName || "") && !root.isBusy("setName")
                            onClicked: root.act("setName", [nameField.text], "Could not set name")
                        }
                    }
                    Item { Layout.preferredHeight: Theme.spacing.tiny }
                    LogosText { textFormat: Text.PlainText;
                        text: "YOUR IDENTITY"
                        color: Theme.palette.textTertiary
                        font.pixelSize: Theme.typography.badgeText
                        font.weight: Theme.typography.weightMedium
                    }
                    // The signing address (from sign.key) — read-only. NOT editable: this is
                    // your cryptographic identity, and it's what an owner adds to make you an
                    // admin. Copy it; don't type over it.
                    LogosText { textFormat: Text.PlainText;
                        Layout.fillWidth: true
                        text: root.st.address || root.st.deviceId || ""
                        color: root.qkTeal
                        font.pixelSize: Theme.typography.badgeText
                        font.family: "monospace"
                        wrapMode: Text.WrapAnywhere
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Theme.spacing.small
                        LogosText { textFormat: Text.PlainText;
                            Layout.fillWidth: true
                            text: "Share this address to be added as an admin"
                            color: root.qkMuted
                            font.pixelSize: Theme.typography.badgeText
                        }
                        LogosButton {
                            text: "Copy"
                            implicitWidth: 64; implicitHeight: 30
                            onClicked: { clip.text = root.st.address || root.st.deviceId || ""; clip.selectAll(); clip.copy(); root.toast("Identity address copied"); }
                        }
                    }

                    // ---- OBS stream overlay ----
                    // qaku_core serves a transparent HTML page on loopback; point an OBS
                    // Browser Source at the URL below. The overlay mirrors the question
                    // list automatically, and honors Hide — hiding a question here removes
                    // it from the stream too.
                    Item { Layout.preferredHeight: Theme.spacing.tiny }
                    LogosText { textFormat: Text.PlainText;
                        text: "STREAM OVERLAY"
                        color: Theme.palette.textTertiary
                        font.pixelSize: Theme.typography.badgeText
                        font.weight: Theme.typography.weightMedium
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Theme.spacing.small
                        // A chip, not a CheckBox/Switch: only LogosText/LogosButton load
                        // reliably across Basecamp versions (see the constraints at the top
                        // of this file), so this copies the sort/filter chip pattern.
                        Rectangle {
                            id: ovlChip
                            implicitWidth: 52; implicitHeight: 26
                            radius: 4
                            color: root.overlayOn ? root.qkGold : root.qkSurface2
                            border.width: 1
                            border.color: root.overlayOn ? root.qkGold : root.qkBorder
                            LogosText { textFormat: Text.PlainText;
                                anchors.centerIn: parent
                                text: root.overlayOn ? "ON" : "OFF"
                                color: root.overlayOn ? root.qkBg : root.qkMuted
                                font.pixelSize: Theme.typography.badgeText
                                font.weight: Theme.typography.weightMedium
                            }
                            MouseArea {
                                anchors.fill: parent
                                cursorShape: Qt.PointingHandCursor
                                onClicked: root.act("setOverlay",
                                                    [JSON.stringify({ enabled: !root.overlayOn,
                                                                      port: parseInt(ovlPort.text) || 7337 })],
                                                    "Could not toggle the overlay")
                            }
                        }
                        AppField {
                            id: ovlPort
                            Layout.preferredWidth: 66
                            text: String((root.st.overlay && root.st.overlay.port) || 7337)
                            inputMethodHints: Qt.ImhDigitsOnly
                        }
                        LogosButton {
                            text: "Save"
                            implicitWidth: 56; implicitHeight: 30
                            enabled: ovlPort.text !== String((root.st.overlay && root.st.overlay.port) || 7337)
                            onClicked: root.act("setOverlay",
                                                [JSON.stringify({ enabled: root.overlayOn,
                                                                  port: parseInt(ovlPort.text) || 7337 })],
                                                "Could not set the overlay port")
                        }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Theme.spacing.small
                        visible: root.overlayOn && !root.overlayErr
                        LogosText { textFormat: Text.PlainText;
                            Layout.fillWidth: true
                            text: (root.st.overlay && root.st.overlay.url) || ""
                            color: root.qkTeal
                            font.pixelSize: Theme.typography.badgeText
                            font.family: "monospace"
                            wrapMode: Text.WrapAnywhere
                        }
                        LogosButton {
                            text: "Copy"
                            implicitWidth: 64; implicitHeight: 30
                            onClicked: { clip.text = (root.st.overlay && root.st.overlay.url) || ""; clip.selectAll(); clip.copy(); root.toast("Overlay URL copied - paste into an OBS Browser Source"); }
                        }
                    }
                    LogosText { textFormat: Text.PlainText;
                        Layout.fillWidth: true
                        visible: root.overlayErr !== ""
                        text: "Overlay: " + root.overlayErr
                        color: Theme.palette.error
                        font.pixelSize: Theme.typography.badgeText
                        wrapMode: Text.WordWrap
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Theme.spacing.small
                        visible: root.overlayOn && !root.overlayErr
                        LogosText { textFormat: Text.PlainText;
                            Layout.fillWidth: true
                            text: root.onStreamCount === 0
                                  ? "Nothing on stream - overlay is blank"
                                  : root.onStreamCount + (root.onStreamCount === 1 ? " question on stream" : " questions on stream")
                            color: root.onStreamCount === 0 ? root.qkMuted : root.qkGold
                            font.pixelSize: Theme.typography.badgeText
                            wrapMode: Text.WordWrap
                        }
                        LogosButton {
                            text: "Clear"
                            implicitWidth: 60; implicitHeight: 30
                            enabled: root.onStreamCount > 0
                            onClicked: root.act("clearOnStream", [], "Could not clear the stream selection")
                        }
                    }
                    LogosText { textFormat: Text.PlainText;
                        Layout.fillWidth: true
                        visible: root.overlayOn && !root.overlayErr
                        text: "Pick questions with + STREAM. Browser Source in OBS, 420x1080."
                        color: root.qkMuted
                        font.pixelSize: Theme.typography.badgeText
                        wrapMode: Text.WordWrap
                    }
                }

                // ---- status line ----
                LogosText { textFormat: Text.PlainText;
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
                    LogosText { textFormat: Text.PlainText;
                        text: (root.showDiag ? "▾  " : "▸  ") + "SYNC / TRANSPORT"
                        color: Theme.palette.textTertiary
                        font.pixelSize: Theme.typography.badgeText
                        font.weight: Theme.typography.weightMedium
                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.showDiag = !root.showDiag }
                    }
                    LogosText { textFormat: Text.PlainText;
                        visible: root.showDiag
                        Layout.fillWidth: true
                        text: "topic " + (root.st.contentTopic || "-")
                        color: Theme.palette.textSecondary
                        font.pixelSize: Theme.typography.badgeText
                        font.family: "monospace"
                        wrapMode: Text.WrapAnywhere
                    }
                    LogosText { textFormat: Text.PlainText;
                        visible: root.showDiag
                        Layout.fillWidth: true
                        text: "shard " + (root.st.shard !== undefined ? root.st.shard : "-")
                              + "   /waku/2/rs/2/" + (root.st.shard !== undefined ? root.st.shard : "?")
                        color: Theme.palette.textSecondary
                        font.pixelSize: Theme.typography.badgeText
                        font.family: "monospace"
                    }
                    LogosText { textFormat: Text.PlainText;
                        visible: root.showDiag
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
                LogosText { textFormat: Text.PlainText;
                    Layout.alignment: Qt.AlignHCenter
                    text: "Welcome to QAKU"
                    color: Theme.palette.text
                    font.pixelSize: Theme.typography.panelTitleText
                    font.weight: Theme.typography.weightBold
                }
                LogosText { textFormat: Text.PlainText;
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
                LogosText { textFormat: Text.PlainText;
                    Layout.alignment: Qt.AlignHCenter
                    text: root.awaitTimedOut ? "Still waiting for a peer…" : "Fetching this Q&A…"
                    color: Theme.palette.text
                    font.pixelSize: Theme.typography.panelTitleText
                    font.weight: Theme.typography.weightBold
                }
                LogosText { textFormat: Text.PlainText;
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    text: root.awaitTimedOut
                        ? "No peer has shared this Q&A's state yet. Make sure a device that hosts it (the phone or a hub, on the same secret) is online — then it stays put and syncs in the background."
                        : "Joined. Waiting for a device that hosts this Q&A (a phone or hub) to send its questions & answers. This can take a few seconds."
                    color: Theme.palette.textSecondary
                    font.pixelSize: Theme.typography.primaryText
                    wrapMode: Text.WordWrap
                }
                LogosText { textFormat: Text.PlainText;
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
                        LogosText { textFormat: Text.PlainText;
                            text: root.hasSession ? (root.st.session.title || "Untitled Q&A") : "QAKU"
                            color: Theme.palette.text
                            font.pixelSize: Theme.typography.panelTitleText
                            font.weight: Theme.typography.weightBold
                        }
                        LogosText { textFormat: Text.PlainText;
                            text: (root.sessionOpen ? "Open" : "Closed") + "   -   " + root.questions.length
                                + (root.questions.length === 1 ? " question" : " questions")
                                + (root.fingerprint ? "   -   fp " + root.fingerprint : "")
                            color: root.sessionOpen ? Theme.palette.success : Theme.palette.textTertiary
                            font.pixelSize: Theme.typography.secondaryText
                        }
                    }
                    LogosButton {
                        text: root.shareOpen ? "Hide share" : "Share"
                        implicitWidth: 110; implicitHeight: 40
                        visible: root.secret.length > 0
                        onClicked: root.shareOpen = !root.shareOpen
                    }
                    LogosButton {
                        visible: root.isAdmin
                        text: root.sessionOpen ? "Close" : "Open"
                        implicitWidth: 110; implicitHeight: 40
                        onClicked: root.act("setConfig", [JSON.stringify({ enabled: !root.sessionOpen })], "Could not change session")
                    }
                }

                // ---- Share card (pairing secret) — collapsed by default; toggled by the header "Share" button ----
                Rectangle {
                    visible: root.secret.length > 0 && root.shareOpen
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
                        LogosText { textFormat: Text.PlainText;
                            text: "Share this Q&A"
                            color: Theme.palette.text
                            font.pixelSize: Theme.typography.subtitleText
                            font.weight: Theme.typography.weightMedium
                        }
                        LogosText { textFormat: Text.PlainText;
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
                                LogosText { textFormat: Text.PlainText;
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
                                LogosText { textFormat: Text.PlainText;
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

                // ---- view tabs: Questions | Polls (same chip look as sort/filter) ----
                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.tiny
                    Repeater {
                        model: [{ k: "questions", l: "Questions (" + root.questions.filter(function (x) { return !x.moderated; }).length + ")" },
                                { k: "polls", l: "Polls (" + root.polls.length + ")" }]
                        delegate: Rectangle {
                            radius: 16; implicitHeight: 32; implicitWidth: tabChipTxt.implicitWidth + 28
                            color: modelData.k === root.paneView ? root.qkGold : root.qkSurface
                            border.color: root.qkBorder; border.width: 1
                            LogosText { textFormat: Text.PlainText; id: tabChipTxt; anchors.centerIn: parent; text: modelData.l; font.pixelSize: Theme.typography.primaryText
                                font.weight: Theme.typography.weightMedium
                                color: modelData.k === root.paneView ? root.qkBg : root.qkMuted }
                            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.paneView = modelData.k }
                        }
                    }
                    Item { Layout.fillWidth: true }
                }

                // ---- Ask a question ----
                RowLayout {
                    visible: root.paneView === "questions"
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
                        enabled: root.sessionOpen && qField.text.length > 0 && !root.isBusy("addQuestion")
                        // Clear the field only once the core accepted it (a failure keeps the text),
                        // and only if the user hasn't started typing something else meanwhile.
                        onClicked: {
                            var asked = qField.text;
                            root.act("addQuestion", [asked], "Could not add question",
                                     function () { if (qField.text === asked) qField.text = ""; });
                        }
                    }
                }

                // ---- sort / filter controls (OG qaku) ----
                RowLayout {
                    visible: root.paneView === "questions"
                    Layout.fillWidth: true
                    spacing: Theme.spacing.medium
                    RowLayout {
                        spacing: Theme.spacing.tiny
                        LogosText { textFormat: Text.PlainText; text: "Sort"; color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText }
                        Repeater {
                            model: [{ k: "top", l: "Top" }, { k: "new", l: "New" }, { k: "old", l: "Old" }]
                            delegate: Rectangle {
                                radius: 14; implicitHeight: 28; implicitWidth: sortChipTxt.implicitWidth + 22
                                color: modelData.k === root.sortBy ? root.qkGold : root.qkSurface
                                border.color: root.qkBorder; border.width: 1
                                LogosText { textFormat: Text.PlainText; id: sortChipTxt; anchors.centerIn: parent; text: modelData.l; font.pixelSize: Theme.typography.secondaryText; color: modelData.k === root.sortBy ? root.qkBg : root.qkMuted }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.sortBy = modelData.k }
                            }
                        }
                    }
                    Item { Layout.fillWidth: true }
                    RowLayout {
                        spacing: Theme.spacing.tiny
                        LogosText { textFormat: Text.PlainText; text: "Show"; color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText }
                        Repeater {
                            model: [{ k: "all", l: "All" }, { k: "unanswered", l: "Unanswered" }, { k: "answered", l: "Answered" }]
                            delegate: Rectangle {
                                radius: 14; implicitHeight: 28; implicitWidth: filterChipTxt.implicitWidth + 22
                                color: modelData.k === root.filterBy ? root.qkGold : root.qkSurface
                                border.color: root.qkBorder; border.width: 1
                                LogosText { textFormat: Text.PlainText; id: filterChipTxt; anchors.centerIn: parent; text: modelData.l; font.pixelSize: Theme.typography.secondaryText; color: modelData.k === root.filterBy ? root.qkBg : root.qkMuted }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.filterBy = modelData.k }
                            }
                        }
                    }
                }

                // ---- Questions ----
                ListView {
                    id: qList
                    visible: root.paneView === "questions"
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    spacing: Theme.spacing.small
                    model: root.visibleQuestions

                    LogosText { textFormat: Text.PlainText;
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
                            LogosText { textFormat: Text.PlainText; anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter
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
                                    LogosText { textFormat: Text.PlainText; width: parent.width; text: modelData.content || ""; color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText; wrapMode: Text.WordWrap }
                                    Row {
                                        width: parent.width; spacing: Theme.spacing.small
                                        LogosText { textFormat: Text.PlainText; text: root.nameOf(modelData.author); color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText }
                                        Item { width: parent.width - 160; height: 1 }
                                        LogosText { textFormat: Text.PlainText; visible: root.isAdmin; text: "Unhide"; color: root.qkTeal; font.pixelSize: Theme.typography.secondaryText
                                            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.act("moderate", [modelData.id, "false"], "Could not unhide") }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    delegate: Rectangle {
                        id: qCard
                        property bool answering: false   // inline answer box opens on demand (declutter)
                        property string acceptedId: modelData.acceptedAnswerId || ""   // for the nested answer delegate
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
                                        LogosText { textFormat: Text.PlainText; Layout.alignment: Qt.AlignHCenter; text: "▲"; color: root.qkGold; font.pixelSize: 11 }
                                        LogosText { textFormat: Text.PlainText; Layout.alignment: Qt.AlignHCenter; text: "" + (modelData.upvotes || 0); color: root.qkText; font.pixelSize: 15; font.weight: Theme.typography.weightMedium }
                                    }
                                    MouseArea { id: upMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                        onClicked: root.act("upvoteQuestion", [modelData.id, "true"], "Could not upvote") }
                                }

                                ColumnLayout {
                                    Layout.fillWidth: true
                                    Layout.alignment: Qt.AlignVCenter
                                    spacing: Theme.spacing.tiny
                                    LogosText { textFormat: Text.PlainText;
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
                                            LogosText { textFormat: Text.PlainText; anchors.centerIn: parent; text: (modelData.author && modelData.author.length > 2) ? modelData.author.charAt(2).toUpperCase() : "?"; color: root.qkText; font.pixelSize: 9; font.weight: Theme.typography.weightBold }
                                        }
                                        LogosText { textFormat: Text.PlainText; text: root.nameOf(modelData.author); color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText }
                                        LogosText { textFormat: Text.PlainText; text: "·  " + root.timeAgo(modelData.ts); color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText; opacity: 0.85 }
                                        // Our own question not yet dispatched to the network (see qaku_core m_unpublished).
                                        LogosText { textFormat: Text.PlainText; visible: !!modelData.queued; text: "·  ⏳ queued"; color: root.qkGold; font.pixelSize: Theme.typography.secondaryText; font.weight: Theme.typography.weightBold }
                                        Item { Layout.preferredWidth: Theme.spacing.tiny; visible: root.overlayOn }
                                        // Stream overlay pick. Only shown while the overlay is running - it is
                                        // meaningless otherwise, and the row is already busy. A Rectangle +
                                        // MouseArea like the sort/filter chips; CheckBox/Switch do not load
                                        // reliably across Basecamp versions (see the notes at the top).
                                        Rectangle {
                                            visible: root.overlayOn
                                            implicitWidth: streamLbl.implicitWidth + 14
                                            implicitHeight: 20
                                            radius: 10
                                            color: modelData.onStream ? root.qkGold : "transparent"
                                            border.width: 1
                                            border.color: modelData.onStream ? root.qkGold : root.qkBorder
                                            LogosText { textFormat: Text.PlainText;
                                                id: streamLbl
                                                anchors.centerIn: parent
                                                text: modelData.onStream ? "● ON STREAM" : "+ STREAM"
                                                color: modelData.onStream ? root.qkBg : root.qkMuted
                                                font.pixelSize: Theme.typography.badgeText
                                                font.weight: Theme.typography.weightMedium
                                            }
                                            MouseArea {
                                                anchors.fill: parent
                                                cursorShape: Qt.PointingHandCursor
                                                onClicked: root.act("setOnStream",
                                                                    [modelData.id, modelData.onStream ? "false" : "true"],
                                                                    "Could not change the stream selection")
                                            }
                                        }
                                    }
                                }

                            }

                            Repeater {
                                model: modelData.answers ? modelData.answers : []
                                delegate: RowLayout {
                                    Layout.fillWidth: true
                                    Layout.leftMargin: 58 + Theme.spacing.medium
                                    spacing: Theme.spacing.small
                                    // upvote pill for the ANSWER (smaller than the question's)
                                    Rectangle {
                                        Layout.alignment: Qt.AlignTop
                                        implicitWidth: 40; implicitHeight: 40
                                        radius: Theme.spacing.radiusSmall
                                        color: aUpMa.containsMouse ? root.qkSurface2 : root.qkBg
                                        border.color: root.qkBorder; border.width: 1
                                        ColumnLayout {
                                            anchors.centerIn: parent; spacing: 0
                                            LogosText { textFormat: Text.PlainText; Layout.alignment: Qt.AlignHCenter; text: "▲"; color: root.qkGold; font.pixelSize: 9 }
                                            LogosText { textFormat: Text.PlainText; Layout.alignment: Qt.AlignHCenter; text: "" + (modelData.upvotes || 0); color: root.qkText; font.pixelSize: 12; font.weight: Theme.typography.weightMedium }
                                        }
                                        MouseArea { id: aUpMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                                            onClicked: root.act("upvoteAnswer", [modelData.id, "true"], "Could not upvote") }
                                    }
                                    ColumnLayout {
                                        Layout.fillWidth: true
                                        Layout.alignment: Qt.AlignVCenter
                                        spacing: Theme.spacing.tiny
                                        LogosText { textFormat: Text.PlainText;
                                            readonly property bool acc: qCard.acceptedId === modelData.id   // one accepted answer per Q
                                            Layout.fillWidth: true
                                            text: (acc ? "✓  " : "") + (modelData.content || "")
                                            color: acc ? root.qkTeal : "#d8d8e0"
                                            font.pixelSize: Theme.typography.secondaryText
                                            wrapMode: Text.WordWrap
                                        }
                                        RowLayout {
                                            spacing: Theme.spacing.tiny
                                            Rectangle {
                                                implicitWidth: 16; implicitHeight: 16; radius: 8
                                                color: Qt.hsla(root.hueFor(modelData.author) / 360, 0.45, 0.32, 1)
                                                LogosText { textFormat: Text.PlainText; anchors.centerIn: parent; text: (modelData.author && modelData.author.length > 2) ? modelData.author.charAt(2).toUpperCase() : "?"; color: root.qkText; font.pixelSize: 8; font.weight: Theme.typography.weightBold }
                                            }
                                            LogosText { textFormat: Text.PlainText; text: root.nameOf(modelData.author); color: root.qkMuted; font.pixelSize: Theme.typography.badgeText }
                                            LogosText { textFormat: Text.PlainText; visible: qCard.acceptedId === modelData.id; text: "·  accepted"; color: root.qkTeal; font.pixelSize: Theme.typography.badgeText; font.weight: Theme.typography.weightMedium }
                                            LogosText { textFormat: Text.PlainText; text: "·  " + root.timeAgo(modelData.ts); color: root.qkMuted; font.pixelSize: Theme.typography.badgeText; opacity: 0.85 }
                                            // owner/admin: accept / unaccept this answer
                                            LogosText { textFormat: Text.PlainText;
                                                visible: root.isAdmin
                                                text: (qCard.acceptedId === modelData.id) ? "·  unaccept" : "·  accept ✓"
                                                color: root.qkGold; font.pixelSize: Theme.typography.badgeText; font.weight: Theme.typography.weightBold
                                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor
                                                    onClicked: root.act("acceptAnswer", [modelData.questionId, modelData.id, (qCard.acceptedId === modelData.id) ? "false" : "true"], "Could not accept") }
                                            }
                                        }
                                    }
                                }
                            }

                            // compact admin actions — subtle text links, no dead input box
                            RowLayout {
                                visible: root.isAdmin
                                Layout.fillWidth: true
                                Layout.leftMargin: 58 + Theme.spacing.medium
                                spacing: Theme.spacing.large
                                LogosText { textFormat: Text.PlainText;
                                    text: qCard.answering ? "Cancel" : "Answer"
                                    color: root.qkTeal; font.pixelSize: Theme.typography.secondaryText
                                    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: qCard.answering = !qCard.answering }
                                }
                                LogosText { textFormat: Text.PlainText;
                                    text: modelData.moderated ? "Show" : "Hide"
                                    color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText
                                    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.act("moderate", [modelData.id, modelData.moderated ? "false" : "true"], "Could not moderate") }
                                }
                                Item { Layout.fillWidth: true }
                            }

                            RowLayout {
                                visible: root.isAdmin && qCard.answering
                                Layout.fillWidth: true
                                Layout.leftMargin: 58 + Theme.spacing.medium
                                spacing: Theme.spacing.small
                                AppField {
                                    id: ansField
                                    Layout.fillWidth: true
                                    implicitHeight: 36
                                    placeholderText: "Write an answer..."
                                }
                                LogosButton {
                                    text: "Post"
                                    implicitWidth: 78; implicitHeight: 36
                                    enabled: ansField.text.length > 0
                                    onClicked: { root.act("postAnswer", [modelData.id, ansField.text], "Could not post answer"); ansField.text = ""; qCard.answering = false; }
                                }
                            }
                        }
                    }
                }

                // ---- Polls pane (tab) ----
                // Every call goes through root.act/mutate (async, de-duplicated, result applied
                // deferred) - a card's handler never reassigns its own model synchronously.
                Flickable {
                    id: pollsFlick
                    visible: root.paneView === "polls"
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    contentWidth: width
                    contentHeight: pollsCol.implicitHeight
                    boundsBehavior: Flickable.StopAtBounds

                    ColumnLayout {
                        id: pollsCol
                        width: pollsFlick.width
                        spacing: Theme.spacing.small

                        // ---- owner/admin: collapsible "New poll" card ----
                        Rectangle {
                            visible: root.canManagePolls
                            Layout.fillWidth: true
                            radius: Theme.spacing.radiusMedium
                            color: root.qkSurface
                            border.color: root.pollFormOpen ? root.qkGold : root.qkBorder
                            border.width: 1
                            implicitHeight: npCol.implicitHeight + 2 * Theme.spacing.medium

                            ColumnLayout {
                                id: npCol
                                anchors.left: parent.left; anchors.right: parent.right
                                anchors.top: parent.top; anchors.margins: Theme.spacing.medium
                                spacing: Theme.spacing.small

                                Item {
                                    Layout.fillWidth: true
                                    implicitHeight: npHead.implicitHeight
                                    LogosText { textFormat: Text.PlainText;
                                        id: npHead
                                        text: (root.pollFormOpen ? "▾  " : "▸  ") + "New poll"
                                        color: root.qkGold
                                        font.pixelSize: Theme.typography.primaryText
                                        font.weight: Theme.typography.weightMedium
                                    }
                                    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.pollFormOpen = !root.pollFormOpen }
                                }

                                ColumnLayout {
                                    visible: root.pollFormOpen
                                    Layout.fillWidth: true
                                    spacing: Theme.spacing.small

                                    LogosText { textFormat: Text.PlainText; text: "Title (optional)"; color: root.qkMuted; font.pixelSize: Theme.typography.badgeText; font.weight: Theme.typography.weightMedium }
                                    AppField {
                                        id: pollTitleField
                                        objectName: "pollTitleField"
                                        Layout.fillWidth: true
                                        implicitHeight: 36
                                        placeholderText: "e.g. Feature priority vote"
                                    }
                                    LogosText { textFormat: Text.PlainText; text: "Question *"; color: root.qkMuted; font.pixelSize: Theme.typography.badgeText; font.weight: Theme.typography.weightMedium }
                                    AppField {
                                        id: pollQuestionField
                                        objectName: "pollQuestionField"
                                        Layout.fillWidth: true
                                        implicitHeight: 38
                                        placeholderText: "What do you want to ask?"
                                    }
                                    LogosText { textFormat: Text.PlainText; text: "Options * (at least 2)"; color: root.qkMuted; font.pixelSize: Theme.typography.badgeText; font.weight: Theme.typography.weightMedium }
                                    Repeater {
                                        model: pollOpts
                                        delegate: RowLayout {
                                            id: optRow
                                            required property int index
                                            required property string label
                                            Layout.fillWidth: true
                                            spacing: Theme.spacing.small
                                            LogosText { textFormat: Text.PlainText;
                                                Layout.preferredWidth: 70
                                                text: "Option " + (optRow.index + 1)
                                                color: root.qkMuted
                                                font.pixelSize: Theme.typography.secondaryText
                                            }
                                            AppField {
                                                Layout.fillWidth: true
                                                implicitHeight: 34
                                                placeholderText: "Option " + (optRow.index + 1)
                                                text: optRow.label
                                                onTextEdited: root.setPollOpt(optRow.index, text)
                                            }
                                            // Remove: DEFERRED - removing the row destroys this delegate,
                                            // which must not happen while its own handler is running.
                                            Rectangle {
                                                Layout.preferredWidth: 26; Layout.preferredHeight: 26
                                                radius: 13
                                                opacity: pollOpts.count > 2 ? 1 : 0.35
                                                color: rmOptMa.containsMouse && pollOpts.count > 2 ? Theme.palette.overlayOrange : "transparent"
                                                border.color: rmOptMa.containsMouse && pollOpts.count > 2 ? Theme.palette.error : Theme.palette.borderHairline
                                                border.width: 1
                                                LogosText { textFormat: Text.PlainText; anchors.centerIn: parent; text: "×"; color: Theme.palette.textTertiary; font.pixelSize: Theme.typography.primaryText }
                                                MouseArea {
                                                    id: rmOptMa; anchors.fill: parent; hoverEnabled: true
                                                    enabled: pollOpts.count > 2
                                                    cursorShape: Qt.PointingHandCursor
                                                    onClicked: { var i = optRow.index; Qt.callLater(function () { root.removePollOpt(i); }); }
                                                }
                                            }
                                        }
                                    }
                                    LogosText { textFormat: Text.PlainText;
                                        text: "+ Add option"
                                        color: root.qkTeal
                                        font.pixelSize: Theme.typography.secondaryText
                                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.addPollOpt() }
                                    }

                                    // Active now + results visibility: chips, not CheckBox/ComboBox (only
                                    // LogosText/LogosButton load reliably across Basecamp versions).
                                    RowLayout {
                                        Layout.fillWidth: true
                                        Layout.topMargin: Theme.spacing.tiny
                                        spacing: Theme.spacing.tiny
                                        Rectangle {
                                            radius: 14; implicitHeight: 28; implicitWidth: actChipTxt.implicitWidth + 22
                                            color: root.pollFormActive ? root.qkGold : root.qkSurface
                                            border.color: root.pollFormActive ? root.qkGold : root.qkBorder; border.width: 1
                                            LogosText { textFormat: Text.PlainText; id: actChipTxt; anchors.centerIn: parent
                                                text: (root.pollFormActive ? "✓ " : "") + "Active now"
                                                font.pixelSize: Theme.typography.secondaryText
                                                color: root.pollFormActive ? root.qkBg : root.qkMuted }
                                            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.pollFormActive = !root.pollFormActive }
                                        }
                                        Item { Layout.preferredWidth: Theme.spacing.medium }
                                        LogosText { textFormat: Text.PlainText; text: "Results"; color: root.qkMuted; font.pixelSize: Theme.typography.secondaryText }
                                        Repeater {
                                            model: [{ k: "always", l: "Always" }, { k: "afterVote", l: "After voting" }]
                                            delegate: Rectangle {
                                                radius: 14; implicitHeight: 28; implicitWidth: resChipTxt.implicitWidth + 22
                                                color: modelData.k === root.pollFormResults ? root.qkGold : root.qkSurface
                                                border.color: root.qkBorder; border.width: 1
                                                LogosText { textFormat: Text.PlainText; id: resChipTxt; anchors.centerIn: parent; text: modelData.l; font.pixelSize: Theme.typography.secondaryText
                                                    color: modelData.k === root.pollFormResults ? root.qkBg : root.qkMuted }
                                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.pollFormResults = modelData.k }
                                            }
                                        }
                                        Item { Layout.fillWidth: true }
                                    }

                                    RowLayout {
                                        Layout.fillWidth: true
                                        Layout.topMargin: Theme.spacing.tiny
                                        spacing: Theme.spacing.small
                                        LogosText { textFormat: Text.PlainText;
                                            Layout.fillWidth: true
                                            text: root.pollFormProblem
                                            color: root.qkGold
                                            font.pixelSize: Theme.typography.secondaryText
                                            wrapMode: Text.WordWrap
                                        }
                                        LogosButton {
                                            text: "Cancel"
                                            implicitWidth: 92; implicitHeight: 38
                                            onClicked: { root.resetPollForm(); root.pollFormOpen = false; }
                                        }
                                        LogosButton {
                                            text: root.isBusy("createPoll") ? "Creating..." : "Create poll"
                                            implicitWidth: 130; implicitHeight: 38
                                            enabled: root.pollFormProblem === "" && !root.isBusy("createPoll")
                                            onClicked: root.submitPoll()
                                        }
                                    }
                                }
                            }
                        }

                        LogosText { textFormat: Text.PlainText;
                            visible: root.polls.length === 0
                            Layout.fillWidth: true
                            Layout.topMargin: Theme.spacing.large
                            horizontalAlignment: Text.AlignHCenter
                            text: root.canManagePolls ? "No polls yet - create one above" : "No polls yet"
                            color: Theme.palette.textTertiary
                            font.pixelSize: Theme.typography.primaryText
                        }

                        // ---- one card per poll ----
                        Repeater {
                            model: root.sortedPolls
                            delegate: Rectangle {
                                id: pCard
                                property var poll: modelData
                                readonly property bool showRes: root.pollShowsResults(poll)
                                readonly property int total: poll.votes || 0
                                readonly property int topCount: root.pollMax(poll)
                                readonly property bool voted: root.hasVoted(poll)
                                Layout.fillWidth: true
                                radius: Theme.spacing.radiusMedium
                                color: root.qkSurface
                                border.color: root.qkBorder
                                border.width: 1
                                opacity: poll.active ? 1 : 0.85
                                implicitHeight: pcol.implicitHeight + 2 * Theme.spacing.medium

                                ColumnLayout {
                                    id: pcol
                                    anchors.left: parent.left; anchors.right: parent.right
                                    anchors.top: parent.top; anchors.margins: Theme.spacing.medium
                                    spacing: Theme.spacing.small

                                    RowLayout {
                                        Layout.fillWidth: true
                                        spacing: Theme.spacing.medium
                                        ColumnLayout {
                                            Layout.fillWidth: true
                                            spacing: 2
                                            LogosText { textFormat: Text.PlainText;
                                                visible: !!pCard.poll.title
                                                Layout.fillWidth: true
                                                text: pCard.poll.title || ""
                                                color: root.qkGold
                                                font.pixelSize: Theme.typography.secondaryText
                                                font.weight: Theme.typography.weightBold
                                                elide: Text.ElideRight
                                            }
                                            LogosText { textFormat: Text.PlainText;
                                                Layout.fillWidth: true
                                                text: pCard.poll.question || ""
                                                color: root.qkText
                                                font.pixelSize: Theme.typography.primaryText
                                                font.weight: Theme.typography.weightMedium
                                                wrapMode: Text.WordWrap
                                            }
                                        }
                                        Rectangle {
                                            Layout.alignment: Qt.AlignTop
                                            radius: 10
                                            implicitWidth: stLbl.implicitWidth + 16; implicitHeight: 20
                                            color: pCard.poll.active ? "transparent" : root.qkSurface2
                                            border.color: pCard.poll.active ? root.qkTeal : root.qkBorder; border.width: 1
                                            LogosText { textFormat: Text.PlainText; id: stLbl; anchors.centerIn: parent
                                                text: pCard.poll.active ? "● ACTIVE" : "CLOSED"
                                                color: pCard.poll.active ? root.qkTeal : root.qkMuted
                                                font.pixelSize: Theme.typography.badgeText; font.weight: Theme.typography.weightMedium }
                                        }
                                    }

                                    LogosText { textFormat: Text.PlainText;
                                        text: pCard.total + (pCard.total === 1 ? " vote" : " votes")
                                              + (pCard.poll.results === "afterVote" ? "   ·   results after voting" : "")
                                              + (pCard.poll.ts ? "   ·   " + root.timeAgo(pCard.poll.ts) : "")
                                        color: root.qkMuted
                                        font.pixelSize: Theme.typography.secondaryText
                                    }

                                    Repeater {
                                        model: pCard.poll.options ? pCard.poll.options : []
                                        delegate: RowLayout {
                                            id: oRow
                                            property var opt: modelData
                                            readonly property int n: root.pollCount(pCard.poll, opt.id)
                                            readonly property bool mine: pCard.poll.myVote === opt.id
                                            readonly property bool leads: pCard.showRes && pCard.topCount > 0 && n === pCard.topCount
                                            readonly property real frac: pCard.total > 0 ? n / pCard.total : 0
                                            Layout.fillWidth: true
                                            spacing: Theme.spacing.small

                                            LogosButton {
                                                text: oRow.mine ? "✓ Voted" : "Vote"
                                                implicitWidth: 92; implicitHeight: 38
                                                enabled: pCard.poll.active && !oRow.mine && !root.isBusy("votePoll")
                                                onClicked: root.act("votePoll", [pCard.poll.id, oRow.opt.id], "Could not vote")
                                            }
                                            // option row with a result bar underneath (width ∝ tally / votes)
                                            Rectangle {
                                                Layout.fillWidth: true
                                                implicitHeight: 38
                                                radius: Theme.spacing.radiusSmall
                                                color: root.qkBg
                                                border.color: oRow.mine ? root.qkTeal : (oRow.leads ? root.qkGold : root.qkBorder)
                                                border.width: 1
                                                clip: true
                                                Rectangle {
                                                    visible: pCard.showRes
                                                    anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
                                                    anchors.margins: 1
                                                    width: Math.max(0, (parent.width - 2) * oRow.frac)
                                                    radius: Theme.spacing.radiusSmall
                                                    color: oRow.leads ? root.qkGold : root.qkTeal
                                                    opacity: oRow.leads ? 0.32 : 0.22
                                                }
                                                RowLayout {
                                                    anchors.fill: parent
                                                    anchors.leftMargin: Theme.spacing.medium; anchors.rightMargin: Theme.spacing.medium
                                                    spacing: Theme.spacing.small
                                                    LogosText { textFormat: Text.PlainText;
                                                        Layout.fillWidth: true
                                                        text: oRow.opt.title + (oRow.mine ? "   ✓ your vote" : "")
                                                        color: oRow.mine ? root.qkTeal : root.qkText
                                                        font.pixelSize: Theme.typography.secondaryText
                                                        font.weight: oRow.leads ? Theme.typography.weightBold : Theme.typography.weightRegular
                                                        elide: Text.ElideRight
                                                    }
                                                    LogosText { textFormat: Text.PlainText;
                                                        visible: pCard.showRes
                                                        text: oRow.n + "   " + Math.round(oRow.frac * 100) + "%"
                                                        color: oRow.leads ? root.qkGold : root.qkMuted
                                                        font.pixelSize: Theme.typography.secondaryText
                                                        font.weight: Theme.typography.weightMedium
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    LogosText { textFormat: Text.PlainText;
                                        visible: !pCard.showRes
                                        text: "Results after you vote"
                                        color: root.qkMuted
                                        font.pixelSize: Theme.typography.secondaryText
                                        font.italic: true
                                    }
                                    LogosText { textFormat: Text.PlainText;
                                        visible: pCard.voted
                                        Layout.fillWidth: true
                                        text: "You voted “" + root.pollOptionTitle(pCard.poll, pCard.poll.myVote) + "”"
                                              + (pCard.poll.active ? " - pick another option to change it" : "")
                                        color: root.qkTeal
                                        font.pixelSize: Theme.typography.secondaryText
                                        wrapMode: Text.WordWrap
                                    }

                                    // owner/admin: compact text-link actions (same style as question admin actions)
                                    RowLayout {
                                        visible: root.canManagePolls
                                        Layout.fillWidth: true
                                        spacing: Theme.spacing.large
                                        LogosText { textFormat: Text.PlainText;
                                            text: pCard.poll.active ? "Close poll" : "Reopen poll"
                                            color: root.qkTeal; font.pixelSize: Theme.typography.secondaryText
                                            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor
                                                onClicked: root.act("setPollActive", [pCard.poll.id, pCard.poll.active ? "false" : "true"], "Could not change the poll") }
                                        }
                                        LogosText { textFormat: Text.PlainText;
                                            text: "Delete"
                                            color: Theme.palette.error; font.pixelSize: Theme.typography.secondaryText
                                            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor
                                                onClicked: root.askDeletePoll(pCard.poll.id, pCard.poll.title || pCard.poll.question) }
                                        }
                                        Item { Layout.fillWidth: true }
                                    }
                                }
                            }
                        }
                        Item { Layout.preferredHeight: Theme.spacing.large }
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
                LogosText { textFormat: Text.PlainText;
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

    // ---- delete-Q&A confirmation overlay (child of root, above everything) ----
    Rectangle {
        visible: root.confirmDeleteId.length > 0
        anchors.fill: parent
        z: 1000
        color: "#99000000"
        MouseArea { anchors.fill: parent; hoverEnabled: true; onClicked: root.confirmDeleteId = "" }
        Rectangle {
            anchors.centerIn: parent
            width: Math.min(parent.width - 4 * Theme.spacing.large, 420)
            implicitHeight: delCol.implicitHeight + 2 * Theme.spacing.large
            radius: Theme.spacing.radiusSmall
            color: root.qkSurface
            border.color: Theme.palette.error; border.width: 1
            MouseArea { anchors.fill: parent }
            ColumnLayout {
                id: delCol
                anchors.left: parent.left; anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.margins: Theme.spacing.large
                spacing: Theme.spacing.medium
                LogosText { textFormat: Text.PlainText;
                    Layout.fillWidth: true
                    text: root.confirmDeleteKind === "poll" ? "Delete this poll?" : "Delete this Q&A?"
                    color: Theme.palette.text; font.weight: Theme.typography.weightBold
                    font.pixelSize: Theme.typography.primaryText
                }
                LogosText { textFormat: Text.PlainText;
                    Layout.fillWidth: true
                    text: root.confirmDeleteKind === "poll"
                          ? "“" + root.confirmDeleteTitle + "” and its votes will be deleted for everyone in this Q&A. This can't be undone."
                          : "“" + root.confirmDeleteTitle + "” will be removed from this device. This can't be undone."
                    color: Theme.palette.textTertiary; wrapMode: Text.WordWrap
                    font.pixelSize: Theme.typography.secondaryText
                }
                RowLayout {
                    Layout.fillWidth: true; spacing: Theme.spacing.small
                    Item { Layout.fillWidth: true }
                    Rectangle {
                        implicitWidth: cancelLbl.implicitWidth + 2 * Theme.spacing.medium
                        implicitHeight: cancelLbl.implicitHeight + Theme.spacing.small
                        radius: Theme.spacing.radiusSmall; color: "transparent"
                        border.color: Theme.palette.borderHairline; border.width: 1
                        LogosText { textFormat: Text.PlainText; id: cancelLbl; anchors.centerIn: parent; text: "Cancel"; color: Theme.palette.text; font.pixelSize: Theme.typography.secondaryText }
                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.confirmDeleteId = "" }
                    }
                    Rectangle {
                        implicitWidth: delLbl.implicitWidth + 2 * Theme.spacing.medium
                        implicitHeight: delLbl.implicitHeight + Theme.spacing.small
                        radius: Theme.spacing.radiusSmall; color: Theme.palette.error
                        LogosText { textFormat: Text.PlainText; id: delLbl; anchors.centerIn: parent; text: "Delete"; color: "#ffffff"; font.pixelSize: Theme.typography.secondaryText; font.weight: Theme.typography.weightBold }
                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.doDelete() }
                    }
                }
            }
        }
    }

    // sidebar UI toggles
    property bool creating: false
    property bool joining: false
}
