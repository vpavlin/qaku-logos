import QtQuick
import QtQuick.Window

// Offscreen harness for module/Main.qml (see render.sh). Args (before the output png):
//   --sync-only  mock bridge WITHOUT callModuleAsync (Basecamp 0.2.0 fallback path)
//   --guest      viewer is NOT owner/admin (afterVote polls hide their counts)
// Phase 1 (questions tab) checks mutate de-dupe + error toast; phase 2 switches to the Polls tab,
// drives the real poll controls (vote / close / delete+confirm / create form) and logs every
// call with its args, then saves the PNG of the Polls tab.
Window {
    id: win
    width: 1280; height: 900; visible: true
    property bool asyncMode: Qt.application.arguments.indexOf("--sync-only") < 0
    property bool guest: Qt.application.arguments.indexOf("--guest") >= 0
    property string outPng: Qt.application.arguments[Qt.application.arguments.length - 1]
    property var calls: []
    readonly property string me: "0xabc0000000000000000000000000000000000001"
    readonly property string other: "0xdef0000000000000000000000000000000000002"
    property var state: ({
        status: "Ready", eventCount: 5, deviceId: me, address: me, myName: "Tester",
        names: { "0xabc0000000000000000000000000000000000001": "Tester" },
        admins: guest ? [other] : [me], role: guest ? "guest" : "owner",
        currentId: "s1",
        sessions: [{ id: "s1", title: "Town Hall", current: true, open: true, questions: 2, role: guest ? "guest" : "owner" }],
        session: { title: "Town Hall", description: "Harness session", enabled: true },
        secret: "a".repeat(64), fingerprint: "ab12cd", contentTopic: "/qaku/1/x/proto", shard: 7,
        questions: [
            { id: "q1", author: me, content: "HARNESS QUESTION ONE?", ts: Date.now() - 120000, upvotes: 3, answers: [
                { id: "a1", questionId: "q1", author: me, content: "An answer", ts: Date.now() - 60000, upvotes: 1 } ] },
            { id: "q2", author: other, content: "HARNESS QUESTION TWO?", ts: Date.now() - 30000, upvotes: 0, answers: [] }
        ],
        polls: [
            { id: "p1", title: "Lunch", question: "Pizza or sushi for the team lunch?", active: true, results: "always",
              ts: Date.now() - 600000, options: [{ id: "o1", title: "Pizza" }, { id: "o2", title: "Sushi" }, { id: "o3", title: "Neither" }],
              tally: { o1: 6, o2: 3, o3: 1 }, votes: 10, myVote: null },
            { id: "p2", title: "", question: "Should we move the town hall to Thursdays?", active: true, results: "afterVote",
              ts: Date.now() - 300000, options: [{ id: "y", title: "Yes" }, { id: "n", title: "No" }],
              tally: { y: 4, n: 1 }, votes: 5, myVote: null },
            { id: "p3", title: "Retro", question: "How did the last sprint go?", active: false, results: "afterVote",
              ts: Date.now() - 3600000, options: [{ id: "g", title: "Great" }, { id: "k", title: "Okay" }, { id: "b", title: "Bad" }],
              tally: { g: 2, k: 5, b: 0 }, votes: 7, myVote: "k" }
        ],
        overlay: { enabled: false, port: 7337 }, sync: {}
    })
    function clone() { return JSON.parse(JSON.stringify(state)); }
    function findPoll(s, id) { for (var i = 0; i < s.polls.length; i++) if (s.polls[i].id === id) return s.polls[i]; return null; }
    function respond(method, args) {
        calls.push(method === "snapshot" || method === "shareQr" ? method : method + " " + JSON.stringify(args));
        if (method === "snapshot") return JSON.stringify(state);
        if (method === "shareQr") return JSON.stringify({ ok: true, n: 2, cells: [1,0,0,1] });
        var s;
        if (method === "addQuestion") {
            s = clone();
            s.questions.push({ id: "q" + (s.questions.length + 1), author: s.deviceId, content: args[0], ts: Date.now(), upvotes: 0, answers: [] });
            state = s; return JSON.stringify(s);
        }
        if (method === "createPoll" || method === "setPollActive" || method === "deletePoll") {
            if (guest) return JSON.stringify({ error: "not an owner/admin" });
            s = clone();
            if (method === "createPoll") {
                var set = args[3] ? JSON.parse(args[3]) : {};
                var opts = JSON.parse(args[1]).map(function (t, i) { return { id: "n" + i, title: t }; });
                s.polls.push({ id: "p" + (s.polls.length + 10), title: set.title || "", question: args[0], active: args[2] === "true",
                               results: set.results || "always", ts: Date.now(), options: opts, tally: {}, votes: 0, myVote: null });
            } else if (method === "setPollActive") {
                findPoll(s, args[0]).active = args[1] === "true";
            } else {
                s.polls = s.polls.filter(function (p) { return p.id !== args[0]; });
            }
            state = s; return JSON.stringify(s);
        }
        if (method === "votePoll") {
            s = clone(); var p = findPoll(s, args[0]);
            if (!p.active) return JSON.stringify({ error: "poll closed" });
            if (p.myVote) { p.tally[p.myVote]--; p.votes--; }
            p.tally[args[1]] = (p.tally[args[1]] || 0) + 1; p.votes++; p.myVote = args[1];
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

    // ---- tree helpers: find VISIBLE items by text / objectName and "click" them ----
    function walk(it, fn) { if (!it) return null; if (fn(it)) return it;
        var ch = it.children || []; for (var i = 0; i < ch.length; i++) { var r = walk(ch[i], fn); if (r) return r; } return null; }
    function shown(it) { for (var x = it; x; x = x.parent) if (x.visible === false) return false; return true; }
    function byText(t, nth) { var n = nth || 0; return walk(loader.item, function (x) { return x.text === t && shown(x) && (n-- === 0); }); }
    function byName(nm) { return walk(loader.item, function (x) { return x.objectName === nm; }); }
    function click(t, nth) {       // a LogosButton (has clicked()) or a LogosText with a child MouseArea
        var x = byText(t, nth); if (!x) { console.log("CLICK-MISS", t); return false; }
        if (x.enabled === false) { console.log("CLICK-DISABLED", t); return false; }
        if (typeof x.clicked === "function" && x.toString().indexOf("Text") < 0) { x.clicked(); return true; }
        var ma = walk(x, function (y) { return y.toString().indexOf("MouseArea") >= 0 && y !== x; });
        if (!ma) ma = walk(x.parent, function (y) { return y.toString().indexOf("MouseArea") >= 0; });
        if (!ma) { console.log("CLICK-NOMA", t); return false; }
        ma.clicked(null); return true;
    }

    Timer { interval: 1500; running: true; onTriggered: {
        var v = loader.item;
        console.log("MODE", asyncMode ? "async" : "sync-fallback", guest ? "guest" : "owner", "status", loader.status, "visibleQuestions", v.visibleQuestions.length, "title", v.st.session ? v.st.session.title : "-", "qr", !!v.qrData);
        console.log("DEDUPE first", v.mutate("addQuestion", ["dup?"]), "second", v.mutate("addQuestion", ["dup?"]), "busy", v.isBusy("addQuestion"));
        v.act("failMe", [], "Expected failure");
    } }
    Timer { interval: 3000; running: true; onTriggered: {
        var v = loader.item;
        console.log("AFTER visibleQuestions", v.visibleQuestions.length, "busy", v.isBusy("addQuestion"), "toast", JSON.stringify(v.toastText));
        click("Polls (3)");
    } }
    // Polls tab: inspect visibility rules, then drive the controls.
    Timer { interval: 3500; running: true; onTriggered: {
        var v = loader.item;
        console.log("POLLS tab", v.paneView, "canManage", v.canManagePolls,
                    "showRes", JSON.stringify(v.sortedPolls.map(function (p) { return p.id + ":" + v.pollShowsResults(p); })),
                    "hiddenHint", !!byText("Results after you vote"), "newPollCard", !!byText("▸  New poll"));
        win.calls = [];
        if (guest) {                                        // screenshot the HIDDEN state first, vote after
            console.log("GUEST admin links", !!byText("Close poll"), "newPollCard", !!byText("▸  New poll"));
            win.contentItem.grabToImage(function (r) { r.saveToFile(win.outPng.replace(/\.png$/, "-before-vote.png")); });
            return;
        }
        click("Vote", 0);                                   // first Vote button = newest poll (p2)
        {
            click("Close poll", 0);                         // p2 -> closed
            click("Delete", 2);                             // oldest card (p3) -> confirm overlay
        }
    } }
    Timer { interval: 4200; running: true; onTriggered: {
        var v = loader.item;
        if (guest) { click("Vote", 0); return; }            // p2 (afterVote) -> counts revealed
        {
            console.log("CONFIRM", v.confirmDeleteKind, v.confirmDeleteId, JSON.stringify(v.confirmDeleteTitle));
            click("Delete", 3);                             // the overlay's red Delete (after 3 card links)
            click("▸  New poll");
        }
    } }
    Timer { interval: 4900; running: true; onTriggered: {
        var v = loader.item;
        if (guest) { console.log("GUEST after vote showRes", JSON.stringify(v.sortedPolls.map(function (p) { return p.id + ":" + v.pollShowsResults(p); })), "hiddenHint", !!byText("Results after you vote")); return; }
        {
            console.log("FORM empty problem", JSON.stringify(v.pollFormProblem), "createEnabled", byText("Create poll").enabled);
            byName("pollTitleField").text = "Harness";
            byName("pollQuestionField").text = "Best harness colour?";
            v.setPollOpt(0, "Gold"); v.setPollOpt(1, "Gold");
            console.log("FORM dup problem", JSON.stringify(v.pollFormProblem));
            v.setPollOpt(1, "Teal"); click("+ Add option"); v.setPollOpt(2, "Grey");
            click("After voting");
            click("✓ Active now");                          // -> inactive
            console.log("FORM ok problem", JSON.stringify(v.pollFormProblem), "opts", JSON.stringify(v.pollOptionTexts()));
            click("Create poll");
            console.log("CREATE busy", v.isBusy("createPoll"), "second click", click("Creating..."));
        }
    } }
    Timer { interval: 6000; running: true; onTriggered: {
        var v = loader.item;
        if (!guest) {
            console.log("AFTER-CREATE formOpen", v.pollFormOpen, "question", JSON.stringify(byName("pollQuestionField").text), "polls", v.polls.length, "toast", JSON.stringify(v.toastText));
            click("▸  New poll");                           // re-open so the screenshot shows the form
            byName("pollQuestionField").text = "What next?";
            v.setPollOpt(0, "Ship it");
        }
    } }
    Timer { interval: 6600; running: true; onTriggered: {
        var v = loader.item;
        var rest = win.calls.filter(function (c) { return c !== "snapshot" && c !== "shareQr"; });
        console.log("POLL CALLS", JSON.stringify(rest));
        console.log("SYNC calls", win.calls.filter(function (c) { return c.indexOf("SYNC:") === 0; }).length);
        console.log("STATE polls", JSON.stringify(v.sortedPolls.map(function (p) { return p.id + (p.active ? "+" : "-") + (p.myVote || ""); })));
        win.contentItem.grabToImage(function (r) { r.saveToFile(win.outPng); Qt.quit(); });
    } }
}
