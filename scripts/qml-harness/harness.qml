import QtQuick
import QtQuick.Window

Window {
    id: win
    width: 1280; height: 860; visible: true
    property bool asyncMode: Qt.application.arguments.indexOf("--sync-only") < 0
    property string outPng: Qt.application.arguments[Qt.application.arguments.length - 1]
    property var calls: []
    property var state: ({
        status: "Ready", eventCount: 5, deviceId: "0xabc0000000000000000000000000000000000001",
        address: "0xabc0000000000000000000000000000000000001", myName: "Tester",
        names: { "0xabc0000000000000000000000000000000000001": "Tester" },
        admins: ["0xabc0000000000000000000000000000000000001"],
        currentId: "s1",
        sessions: [{ id: "s1", title: "Town Hall", current: true, open: true, questions: 2, role: "owner" }],
        session: { title: "Town Hall", description: "Harness session", enabled: true },
        secret: "a".repeat(64), fingerprint: "ab12cd", contentTopic: "/qaku/1/x/proto", shard: 7,
        questions: [
            { id: "q1", author: "0xabc0000000000000000000000000000000000001", content: "HARNESS QUESTION ONE?", ts: Date.now() - 120000, upvotes: 3, answers: [
                { id: "a1", questionId: "q1", author: "0xabc0000000000000000000000000000000000001", content: "An answer", ts: Date.now() - 60000, upvotes: 1 } ] },
            { id: "q2", author: "0xdef0000000000000000000000000000000000002", content: "HARNESS QUESTION TWO?", ts: Date.now() - 30000, upvotes: 0, answers: [] }
        ],
        polls: [], overlay: { enabled: false, port: 7337 }, sync: {}
    })
    function respond(method, args) {
        calls.push(method);
        if (method === "snapshot") return JSON.stringify(state);
        if (method === "shareQr") return JSON.stringify({ ok: true, n: 2, cells: [1,0,0,1] });
        if (method === "addQuestion") {
            var s = JSON.parse(JSON.stringify(state));
            s.questions.push({ id: "q" + (s.questions.length + 1), author: s.deviceId, content: args[0], ts: Date.now(), upvotes: 0, answers: [] });
            state = s; return JSON.stringify(s);
        }
        if (method === "failMe") return JSON.stringify({ error: "boom" });
        return JSON.stringify(state);
    }
    Component { id: asyncLogos
        QtObject {
            signal moduleEventReceived(string moduleName, string eventName, string data)
            function onModuleEvent(m, e) { win.calls.push("onModuleEvent:" + e); }
            function callModule(m, meth, args) { win.calls.push("SYNC:" + meth); return win.respond(meth, args); }
            function callModuleAsync(m, meth, args, cb, t) {
                var tm = Qt.createQmlObject('import QtQuick; Timer { interval: 150 }', win);
                tm.triggered.connect(function () { cb(win.respond(meth, args)); tm.destroy(); });
                tm.start();
            }
        }
    }
    Component { id: syncLogos
        QtObject {
            signal moduleEventReceived(string moduleName, string eventName, string data)
            function callModule(m, meth, args) { win.calls.push("SYNC:" + meth); return win.respond(meth, args); }
        }
    }
    property var logos: asyncMode ? asyncLogos.createObject(win) : syncLogos.createObject(win)
    Loader { id: loader; anchors.fill: parent; source: Qt.resolvedUrl("../../module/Main.qml") }
    Timer { interval: 1500; running: true; onTriggered: {
        var v = loader.item;
        console.log("MODE", asyncMode ? "async" : "sync-fallback", "status", loader.status, "visibleQuestions", v.visibleQuestions.length, "title", v.st.session ? v.st.session.title : "-", "qr", !!v.qrData);
        console.log("DEDUPE first", v.mutate("addQuestion", ["dup?"]), "second", v.mutate("addQuestion", ["dup?"]), "busy", v.isBusy("addQuestion"));
        v.act("failMe", [], "Expected failure");
    } }
    Timer { interval: 3000; running: true; onTriggered: {
        var v = loader.item;
        console.log("AFTER visibleQuestions", v.visibleQuestions.length, "busy", v.isBusy("addQuestion"), "toast", JSON.stringify(v.toastText));
        console.log("CALLS", JSON.stringify(win.calls));
        win.contentItem.grabToImage(function (r) { r.saveToFile(win.outPng); Qt.quit(); });
    } }
}
