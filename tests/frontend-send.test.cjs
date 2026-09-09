"use strict";

// Run with: node --test tests/frontend-send.test.cjs
// Executes the actual browser script without a server, SDK, network, or npm install.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const routeCore = require("../route-core.js");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

class Element {
    constructor(tagName = "div") {
        this.tagName = tagName;
        this.children = [];
        this.parentNode = null;
        this.listeners = new Map();
        this.attributes = new Map();
        this.style = {};
        this.dataset = {};
        this.value = "";
        this.disabled = false;
        this._text = "";
        const classes = new Set();
        this.classList = {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            toggle: (name, force) => {
                const add = force === undefined ? !classes.has(name) : force;
                if (add) classes.add(name);
                else classes.delete(name);
                return add;
            }
        };
    }

    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    set innerHTML(value) { this._html = value; this._text = ""; this.children = []; }
    get innerHTML() { return this._html || ""; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    replaceChildren(...children) { this._text = ""; this.children = []; this.append(...children); }
    remove() {
        if (this.parentNode) {
            this.parentNode.children = this.parentNode.children.filter(child => child !== this);
            this.parentNode = null;
        }
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(name, handler) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(handler);
    }
    focus() { this.focused = true; this.focusCount = (this.focusCount || 0) + 1; }
    blur() { this.focused = false; this.blurCount = (this.blurCount || 0) + 1; }
    dispatch(name, properties = {}) {
        const event = {
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            ...properties
        };
        for (const handler of this.listeners.get(name) || []) handler(event);
        return event;
    }
}

const response = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
});

function waitForAbort(_url, options) {
    return new Promise((_, reject) => {
        const abort = () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
    });
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function createApp({ chat = () => response({ reply: "你好，想从哪里开始散步？", action: "chat", source: "model" }),
    protocol = "http:", mapSdk, filter, filterMetadata = {}, mobile = false, catalog = [] } = {}) {
    const elements = new Map();
    const quickPrompts = [new Element("button"), new Element("button")];
    quickPrompts[0].textContent = "我想看老建筑";
    quickPrompts[1].textContent = "帮我规划散步";
    const document = {
        head: new Element("head"),
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element());
            return elements.get(id);
        },
        createElement: tag => new Element(tag),
        querySelectorAll: selector => selector === ".quick-prompt" ? quickPrompts : []
    };
    const timers = new Map();
    const animationFrames = [];
    let timerSequence = 0;
    const schedule = (callback, delay) => {
        const id = ++timerSequence;
        timers.set(id, { callback, delay });
        return id;
    };
    const requests = [];
    const fetch = async (url, options = {}) => {
        if (url.endsWith("/api/health")) return response({ ai_configured: true });
        if (url.includes("/api/places/search?")) return typeof catalog === "function" ? catalog(url) : response({ places: catalog });
        if (url.endsWith("/api/filter_pois")) return response({
            source: "model", filtered_names: filter ? filter(JSON.parse(options.body).poi_names) : JSON.parse(options.body).poi_names,
            ...filterMetadata
        });
        assert.ok(url.endsWith("/api/chat"), `Unexpected endpoint: ${url}`);
        requests.push({ url, options, body: JSON.parse(options.body) });
        return chat(url, options, requests.length);
    };
    // Mirror initial HTML attributes; mobile visibility is controlled by these
    // attributes, while browser smoke tests cover actual CSS and map geometry.
    document.getElementById("app").dataset.mobileView = "map";
    document.getElementById("panel").dataset.expanded = "false";
    document.getElementById("mobile-map-tab").setAttribute("aria-pressed", "true");
    document.getElementById("mobile-chat-tab").setAttribute("aria-pressed", "false");
    document.getElementById("panel-toggle").setAttribute("aria-expanded", "false");
    const window = {
        location: { protocol }, setTimeout: schedule, BMapGL: mapSdk, CitywalkRouteCore: routeCore,
        matchMedia: query => ({ media: query, matches: mobile && query.includes("(max-width: 640px)") }),
        requestAnimationFrame: callback => { animationFrames.push(callback); callback(); return animationFrames.length; }
    };
    vm.runInNewContext(source, {
        document,
        window,
        fetch,
        AbortController,
        DOMException,
        BMapGL: mapSdk,
        BMAP_STATUS_SUCCESS: 0,
        setTimeout: schedule,
        clearTimeout: id => timers.delete(id),
        console
    }, { filename: "app.js" });

    return {
        window,
        document,
        requests,
        quickPrompts,
        input: elements.get("chat-input"),
        send: elements.get("send-btn"),
        messages: elements.get("chat-messages"),
        status: elements.get("service-status"),
        route: elements.get("route-list"),
        summary: elements.get("route-summary"),
        context: elements.get("context-chips"),
        appRoot: elements.get("app"),
        panel: elements.get("panel"),
        panelToggle: elements.get("panel-toggle"),
        mapTab: elements.get("mobile-map-tab"),
        chatTab: elements.get("mobile-chat-tab"),
        animationFrames,
        fireTimeout(delay) {
            const matching = [...timers].filter(([, timer]) => timer.delay === delay);
            assert.ok(matching.length, `Expected a ${delay} ms timeout`);
            for (const [id, timer] of matching) {
                timers.delete(id);
                timer.callback();
            }
        }
    };
}

function assertReady(app) {
    assert.equal(app.send.disabled, false, "send control stays usable");
    assert.equal(app.send.getAttribute("aria-busy"), "false", "busy state is cleared");
    assert.equal(app.send.getAttribute("aria-label"), "发送");
    assert.equal(app.input.disabled, false);
    assert.ok(app.quickPrompts.every(button => !button.disabled));
}

test("click sends and receives a reply even when the map SDK never calls back", async () => {
    const app = createApp();
    assert.equal(app.document.head.children.length, 1);
    assert.match(app.document.head.children[0].src, /callback=citywalkMapReady/);
    assert.equal(typeof app.window.citywalkMapReady, "function");
    // Deliberately do not load BMapGL or invoke its SDK callback.
    app.input.value = "你好";
    app.send.dispatch("click");
    await flush();
    assert.equal(app.requests.length, 1);
    assert.equal(app.requests[0].body.message, "你好");
    assert.match(app.messages.textContent, /你好，想从哪里开始散步/);
    assert.doesNotMatch(app.messages.textContent, /正在理解/);
    assert.equal(app.input.value, "");
    assertReady(app);
});

test("Enter sends once and keeps the successful conversation in the next request", async () => {
    const app = createApp();
    app.input.value = "第一条消息";
    const event = app.input.dispatch("keydown", { key: "Enter" });
    assert.equal(event.defaultPrevented, true);
    await flush();
    app.input.value = "第二条消息";
    app.input.dispatch("keydown", { key: "Enter" });
    await flush();
    assert.equal(app.requests.length, 2);
    assert.equal(app.requests[1].body.message, "第二条消息");
    assert.equal(app.requests[1].body.history[0].content, "第一条消息");
    assertReady(app);
});

test("Chinese IME confirmation and Shift+Enter do not send", async () => {
    const app = createApp();
    app.input.value = "正在输入中文";
    for (const properties of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) {
        const event = app.input.dispatch("keydown", { key: "Enter", ...properties });
        assert.equal(event.defaultPrevented, false);
    }
    await flush();
    assert.equal(app.requests.length, 0);
    assert.equal(app.input.value, "正在输入中文");
});

for (const [name, chat] of [
    ["network failure", () => { throw new TypeError("Failed to fetch"); }],
    ["HTTP failure", () => response({}, 503)],
    ["invalid JSON", () => ({ ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } })]
]) {
    test(`${name} clears busy state and restores the message for retry`, async () => {
        const app = createApp({ chat });
        app.input.value = "我想看老建筑";
        app.send.dispatch("click");
        await flush();
        assert.equal(app.input.value, "我想看老建筑");
        assert.match(app.messages.textContent, /没有连上服务/);
        assert.doesNotMatch(app.messages.textContent, /正在理解/);
        assertReady(app);
    });
}

test("a timed-out request restores input and allows the next send", async () => {
    const app = createApp({ chat: (url, options, count) => count === 1
        ? waitForAbort(url, options)
        : response({ reply: "重试成功", action: "chat", source: "model" }) });
    app.input.value = "请帮我规划";
    app.send.dispatch("click");
    assert.equal(app.send.getAttribute("aria-busy"), "true");
    app.fireTimeout(25000);
    await flush();
    assert.equal(app.input.value, "请帮我规划");
    assert.match(app.messages.textContent, /等待超时/);
    assertReady(app);
    app.send.dispatch("click");
    await flush();
    assert.equal(app.requests.length, 2);
    assert.match(app.messages.textContent, /重试成功/);
    assertReady(app);
});

test("stop aborts the pending request and permits immediate retry", async () => {
    const app = createApp({ chat: (url, options, count) => count === 1
        ? waitForAbort(url, options)
        : response({ reply: "重新发送成功", action: "chat", source: "model" }) });
    app.input.value = "从上海图书馆出发";
    app.send.dispatch("click");
    assert.equal(app.send.getAttribute("aria-label"), "停止等待");
    assert.equal(app.send.disabled, false);
    app.send.dispatch("click");
    await flush();
    assert.equal(app.requests[0].options.signal.aborted, true);
    assert.equal(app.input.value, "从上海图书馆出发");
    assert.match(app.messages.textContent, /已停止等待/);
    assertReady(app);
    app.send.dispatch("click");
    await flush();
    assert.equal(app.requests.length, 2);
    assert.match(app.messages.textContent, /重新发送成功/);
    assertReady(app);
});

test("failure does not overwrite a new draft typed while waiting", async () => {
    const app = createApp({ chat: waitForAbort });
    app.input.value = "原始消息";
    app.send.dispatch("click");
    app.input.value = "这是我的新草稿";
    app.input.dispatch("keydown", { key: "Enter" });
    assert.equal(app.requests.length, 1, "busy Enter does not submit or cancel a second request");
    app.fireTimeout(25000);
    await flush();
    assert.equal(app.input.value, "这是我的新草稿");
    assertReady(app);
});

test("stop also releases a stalled map lookup after the AI reply", async () => {
    const { sdk: mapSdk, control } = createMapSdk();
    control.holdSearch = true;
    const app = createApp({ mapSdk, chat: (_url, _options, count) => count === 1
        ? response({ reply: "正在为你规划", action: "plan_route", source: "model",
            keywords: ["历史建筑"], trip_state: { start: "上海图书馆" } })
        : response({ reply: "聊天已经恢复", action: "chat", source: "model" }) });
    app.window.citywalkMapReady();
    app.input.value = "从上海图书馆出发看老建筑";
    app.send.dispatch("click");
    await flush();
    assert.equal(control.pendingSearch.length, 1, "planning reached verified LocalSearch lookup");
    assert.equal(app.send.getAttribute("aria-busy"), "true");
    app.send.dispatch("click");
    await flush();
    assert.match(app.messages.textContent, /已停止等待/);
    assertReady(app);
    app.send.dispatch("click");
    await flush();
    assert.equal(app.requests.length, 2);
    assert.match(app.messages.textContent, /聊天已经恢复/);
    const completedText = app.messages.textContent;
    control.pendingSearch.shift()();
    await flush();
    assert.equal(app.messages.textContent, completedText, "late map callbacks cannot update the cancelled conversation");
    assertReady(app);
});

test("opening the HTML directly still targets the local backend", async () => {
    const app = createApp({ protocol: "file:" });
    app.input.value = "你好";
    app.send.dispatch("click");
    await flush();
    assert.equal(app.requests[0].url, "http://127.0.0.1:8000/api/chat");
    assertReady(app);
});

const fixturePois = () => ({
    "上海图书馆": { title: "上海图书馆", point: { lng: 121.44, lat: 31.20 } },
    "徐家汇地铁站": { title: "徐家汇地铁站", point: { lng: 121.444, lat: 31.196 } },
    "一号咖啡馆": { title: "一号咖啡馆", point: { lng: 121.441, lat: 31.20 } },
    "二号咖啡馆": { title: "二号咖啡馆", point: { lng: 121.443, lat: 31.20 } },
    "附近咖啡馆": { title: "附近咖啡馆", point: { lng: 121.444, lat: 31.20 } },
    "美罗城": { title: "美罗城", point: { lng: 121.444, lat: 31.194 } },
    "港汇恒隆广场": { title: "港汇恒隆广场", point: { lng: 121.442, lat: 31.195 } },
    "远处地标": { title: "远处地标", point: { lng: 121.6, lat: 31.20 } }
});

function createMapSdk() {
    const pois = fixturePois();
    const control = {
        queries: [], walks: [], maps: [], pendingSearch: [], pendingWalking: [],
        holdSearch: false, holdWalking: false, failWalking: false,
        nearby: [pois["一号咖啡馆"], pois["二号咖啡馆"]],
        distance: () => 200, seconds: () => 180
    };
    const result = list => ({ getCurrentNumPois: () => list.length, getPoi: index => list[index] });
    const sdk = {
        Point: class { constructor(lng, lat) { this.lng = lng; this.lat = lat; } },
        Map: class {
            constructor() { this.overlays = []; control.maps.push(this); }
            centerAndZoom() {}
            enableScrollWheelZoom() {}
            setMapStyleV2() {}
            clearOverlays() { this.overlays = []; }
            addOverlay(overlay) { this.overlays.push(overlay); }
            panTo(point) { this.center = point; }
            setViewport(points) { this.viewport = points; }
        },
        Label: class { constructor(text) { this.text = text; } setStyle() {} },
        Marker: class {
            constructor(point) { this.point = point; }
            setLabel(label) { this.label = label; }
            addEventListener() {}
        },
        Size: class {},
        Polyline: class { constructor(points) { this.points = points; } },
        LocalSearch: class {
            constructor(_context, options) { this.options = options; }
            getStatus() { return 0; }
            search(query) {
                control.queries.push({ type: "name", query });
                const name = query.replace(/^上海徐汇\s+/, "");
                const complete = () => this.options.onSearchComplete(result(pois[name] ? [pois[name]] : []));
                if (control.holdSearch) control.pendingSearch.push(complete);
                else queueMicrotask(complete);
            }
            searchNearby(query, center, radius) {
                control.queries.push({ type: "nearby", query, center, radius });
                queueMicrotask(() => this.options.onSearchComplete(result(control.nearby)));
            }
        },
        WalkingRoute: class {
            setSearchCompleteCallback(callback) { this.callback = callback; }
            getStatus() { return control.failWalking ? 1 : 0; }
            search(start, end) {
                control.walks.push({ start, end });
                const complete = () => this.callback({ getPlan: () => ({
                    getRoute: () => ({ getPath: () => [start, end] }),
                    getDistance: format => { assert.equal(format, false); return control.distance(start, end); },
                    getDuration: format => { assert.equal(format, false); return control.seconds(start, end); }
                }) });
                if (control.holdWalking) control.pendingWalking.push(complete);
                else queueMicrotask(complete);
            }
        }
    };
    return { sdk, control, pois };
}

const planPayload = (state = {}) => ({
    action: "plan_route", intent: "plan_route", source: "model", keywords: ["咖啡馆"],
    reply: "已添加美罗城和港汇，所有要求都满足了。",
    trip_state: { start: "上海图书馆", duration_minutes: 120, theme: ["咖啡"], end: null,
        max_walk_meters: null, required_places: [], excluded_places: [], required_categories: [], ...state }
});

const catalogFixture = { id: "curated-cafe", name: "附近咖啡馆", aliases: [], address: "上海市徐汇区武康路376号",
    tags: ["coffee", "咖啡馆"], editorial_tags: ["松弛感"], sources: [{ title: "官方资料", url: "https://example.org/place" }] };

test("catalog matching adds verified tags and source link and takes priority over generic candidates", async () => {
    const { app, pois } = createRouteApp([planPayload({ duration_minutes: 60 })], { catalog: [catalogFixture] });
    pois["附近咖啡馆"].address = "上海市徐汇区武康路376号一层";
    await sendText(app, "从上海图书馆出发，想找松弛感的咖啡馆");
    assert.match(app.route.textContent, /附近咖啡馆/);
    assert.match(app.messages.textContent, /地点库标签：咖啡馆.*名称与地址已由地图核对/);
    assert.match(app.messages.textContent, /查看地点资料/);
    assert.equal(app.status.textContent, "AI 已回复");
    assertReady(app);
});

for (const [issue, changes] of [["wrong address", { address: "武康路999号" }],
    ["different branch", { title: "附近咖啡馆(另一分店)", address: "武康路376号" }],
    ["outside walking radius", { address: "武康路376号", point: { lng: 121.489, lat: 31.20 } }]]) {
    test(`catalog ${issue} is not added or represented as a verified catalog destination`, async () => {
        const { app, pois } = createRouteApp([planPayload({ duration_minutes: 60 })], { catalog: [catalogFixture] });
        Object.assign(pois["附近咖啡馆"], changes);
        await sendText(app, "找附近咖啡馆");
        assert.doesNotMatch(app.route.textContent, /附近咖啡馆/);
        assert.doesNotMatch(app.messages.textContent, /地点库标签|查看地点资料/);
        assertReady(app);
    });
}

test("catalog failure preserves ordinary map search and never labels AI disconnected", async () => {
    const { app } = createRouteApp([planPayload()], { catalog: () => { throw new TypeError("catalog unavailable"); } });
    await sendText(app, "从上海图书馆逛咖啡");
    assert.match(app.route.textContent, /一号咖啡馆/);
    assert.equal(app.status.textContent, "AI 已回复");
    assertReady(app);
});
const modifyPayload = (operation, options = {}, state = {}) => ({
    action: "modify_route", intent: "modify_route", source: "model", keywords: ["咖啡馆"],
    reply: "已经改好了，放心按新路线走。", trip_state: state,
    modification: { operation, keep_others: true, ...options }
});

function createRouteApp(payloads, options = {}) {
    const { sdk, control, pois } = createMapSdk();
    const app = createApp({ ...options, mapSdk: sdk, chat: (_url, _options, count) => response(payloads[count - 1]
        || { intent: "chat", source: "model", reply: "当前路线不变。" }) });
    app.window.citywalkMapReady();
    return { app, control, pois };
}

async function sendText(app, text) {
    app.input.value = text;
    app.send.dispatch("click");
    await flush();
}

function appliedView(app) {
    return { route: app.route.textContent, summary: app.summary.textContent, context: app.context.textContent,
        origin: app.document.getElementById("gps-input").value };
}

test("extend adds a new stop, proves increased walking distance, and undo restores exactly", async () => {
    const { app, control, pois } = createRouteApp([planPayload(), modifyPayload("extend")]);
    await sendText(app, "先规划咖啡路线");
    const before = appliedView(app);
    control.nearby.push(pois["附近咖啡馆"]);
    await sendText(app, "长一点");
    assert.match(app.route.textContent, /1. 一号咖啡馆.*2. 二号咖啡馆.*3. 附近咖啡馆/);
    assert.match(app.messages.textContent, /从 400 米延长到 600 米（增加 200 米）/);
    assert.match(app.summary.textContent, /步行 600 米/);
    await sendText(app, "撤销上一步");
    assert.deepEqual(appliedView(app), before);
});

test("extend preserves a fixed endpoint and inserts before it", async () => {
    const { app, control, pois } = createRouteApp([planPayload({ end: "二号咖啡馆" }), modifyPayload("extend")]);
    await sendText(app, "安排咖啡路线，最后到二号咖啡馆");
    control.nearby.push(pois["附近咖啡馆"]);
    await sendText(app, "长一点");
    assert.match(app.route.textContent, /1. 一号咖啡馆.*2. 附近咖啡馆.*3. 二号咖啡馆/);
    assert.match(app.summary.textContent, /步行 600 米/);
    assert.match(app.context.textContent, /终点 · 二号咖啡馆/);
});

test("extend cannot silently repeat old stops or pretend the same route is longer", async () => {
    const { app } = createRouteApp([planPayload(), modifyPayload("extend")]);
    await sendText(app, "先规划咖啡路线");
    const before = appliedView(app);
    await sendText(app, "长一点");
    assert.deepEqual(appliedView(app), before);
    assert.match(app.messages.textContent, /未找到合适的新地点/);
    assert.doesNotMatch(app.messages.textContent, /延长到/);
    assertReady(app);
});

test("extend respects an existing walking cap without publishing failed changes", async () => {
    const { app, control, pois } = createRouteApp([planPayload({ max_walk_meters: 400 }), modifyPayload("extend")]);
    await sendText(app, "最多走400米");
    const before = appliedView(app);
    control.nearby.push(pois["附近咖啡馆"]);
    await sendText(app, "长一点");
    assert.deepEqual(appliedView(app), before);
    assert.match(app.messages.textContent, /超过你要求的 400 米上限/);
    assert.doesNotMatch(app.messages.textContent, /延长到/);
});

test("an extra stop with no measured distance increase is not accepted as extending", async () => {
    const { app, control, pois } = createRouteApp([planPayload(), modifyPayload("extend")]);
    await sendText(app, "先规划咖啡路线");
    const before = appliedView(app);
    control.nearby.push(pois["附近咖啡馆"]);
    control.distance = () => 0;
    await sendText(app, "长一点");
    assert.deepEqual(appliedView(app), before);
    assert.doesNotMatch(app.messages.textContent, /延长到/);
});

test("full app generates two verified stops and reports measured distance instead of the target duration", async () => {
    const { app, control } = createRouteApp([planPayload()]);
    await sendText(app, "从上海图书馆出发，逛两家咖啡馆");
    assert.equal(app.route.children.length, 3);
    assert.match(app.route.textContent, /起点：上海图书馆.*1. 一号咖啡馆.*2. 二号咖啡馆/);
    assert.match(app.summary.textContent, /步行 400 米.*26 分钟.*2 站/);
    assert.match(app.context.textContent, /目标时长 · 2\s*小时/);
    assert.equal(control.walks.length, 2);
    assert.doesNotMatch(app.messages.textContent, /已添加美罗城|所有要求都满足/);
    assertReady(app);
});

test("full app follows an exact reorder and undo restores the exact prior route, origin, labels and metrics", async () => {
    const { app } = createRouteApp([
        planPayload(), modifyPayload("reorder", { places: ["二号咖啡馆", "一号咖啡馆"] })
    ]);
    await sendText(app, "先安排咖啡路线");
    const before = appliedView(app);
    await sendText(app, "按二号咖啡馆、一号咖啡馆顺序走");
    assert.match(app.route.textContent, /1. 二号咖啡馆.*2. 一号咖啡馆/);
    assert.notEqual(app.route.textContent, before.route);
    await sendText(app, "撤销上一步");
    assert.deepEqual(appliedView(app), before);
    assert.equal(app.requests.length, 2, "an explicit undo is local and does not call the model");
    assert.match(app.messages.textContent, /已撤销上一步/);
    assertReady(app);
});

test("full app holds old labels during validation and rolls back a failed change without showing model success", async () => {
    const { app, control } = createRouteApp([
        planPayload(), modifyPayload("reorder", { places: ["二号咖啡馆", "一号咖啡馆"] }, { max_walk_meters: 100 })
    ]);
    await sendText(app, "先安排咖啡路线");
    const before = appliedView(app);
    control.holdWalking = true;
    await sendText(app, "调序并限制在100米内");
    assert.equal(app.send.getAttribute("aria-busy"), "true");
    assert.deepEqual(appliedView(app), before, "proposed constraints are not shown as applied");
    assert.doesNotMatch(app.messages.textContent, /已经改好了|放心按新路线/);
    control.holdWalking = false;
    control.pendingWalking.shift()();
    await flush();
    assert.deepEqual(appliedView(app), before);
    assert.match(app.messages.textContent, /这次没有生效.*步行/s);
    assert.match(app.messages.textContent, /原路线已保留/);
    assertReady(app);
});

test("full app clears a fixed endpoint but keeps that stop and its order", async () => {
    const { app } = createRouteApp([
        planPayload({ end: "二号咖啡馆" }),
        { ...modifyPayload("change_end", { value: null }, { end: null }), clear_fields: ["end"] }
    ]);
    await sendText(app, "最后在二号咖啡馆结束");
    const initialStops = app.route.children.map(item => item.children[0]?.textContent || item.textContent);
    assert.match(app.context.textContent, /终点 · 二号咖啡馆/);
    await sendText(app, "取消固定终点，地点不要删");
    assert.doesNotMatch(app.context.textContent, /终点 ·/);
    assert.deepEqual(app.route.children.map(item => item.children[0]?.textContent || item.textContent), initialStops);
    assert.doesNotMatch(app.route.textContent, /你指定的最后一站/);
    await sendText(app, "当前条件是什么");
    assert.equal(app.requests.at(-1).body.trip_state.end, null);
    assertReady(app);
});

test("full app changes the real origin coordinates as well as its labels and can restore the first route", async () => {
    const { app, control, pois } = createRouteApp([
        planPayload(), modifyPayload("change_start", { value: "徐家汇地铁站" }, { start: "徐家汇地铁站" }),
        modifyPayload("restore_initial")
    ]);
    await sendText(app, "先安排咖啡路线");
    const before = appliedView(app);
    await sendText(app, "现在改从徐家汇地铁站出发");
    assert.match(app.route.textContent, /起点：徐家汇地铁站/);
    assert.match(app.context.textContent, /起点 · 徐家汇地铁站/);
    assert.ok(control.walks.some(leg => leg.start === pois["徐家汇地铁站"].point), "walking SDK receives the new origin point");
    assert.equal(control.maps[0].overlays[0].point, pois["徐家汇地铁站"].point);
    await sendText(app, "请恢复第一次的路线和起点");
    assert.deepEqual(appliedView(app), before);
    assert.equal(control.maps[0].overlays[0].point, pois["上海图书馆"].point);
    assertReady(app);
});

test("full app exact set_stops replaces all stops and never leaves an explicitly unwanted old stop", async () => {
    const { app } = createRouteApp([
        planPayload(), modifyPayload("set_stops", { places: ["美罗城", "港汇恒隆广场"], keep_others: false },
            { excluded_places: ["一号咖啡馆", "二号咖啡馆"] })
    ]);
    await sendText(app, "先安排咖啡路线");
    await sendText(app, "只保留美罗城和港汇恒隆广场");
    assert.match(app.route.textContent, /1. 美罗城.*2. 港汇恒隆广场/);
    assert.doesNotMatch(app.route.textContent, /一号咖啡馆|二号咖啡馆/);
    assert.equal(app.route.children.length, 3);
    assertReady(app);
});

test("a generic coffee ending searches near the last stop, never geocodes the category", async () => {
    const { app, control, pois } = createRouteApp([
        planPayload(), modifyPayload("change_end", { value: "咖啡馆" }, { end: "咖啡馆" })
    ]);
    await sendText(app, "先安排咖啡路线");
    control.queries = [];
    control.nearby = [pois["远处地标"], pois["附近咖啡馆"]];
    await sendText(app, "最后找一家咖啡馆");
    assert.equal(control.queries.filter(query => query.type === "name").length, 0);
    assert.equal(control.queries[0].center, pois["二号咖啡馆"].point);
    assert.match(app.route.textContent, /3. 附近咖啡馆/);
    assert.match(app.context.textContent, /终点 · 附近咖啡馆/);
    assertReady(app);
});

test("a remote explicit endpoint is rejected without changing the existing route", async () => {
    const { app } = createRouteApp([
        planPayload(), modifyPayload("change_end", { value: "远处地标" }, { end: "远处地标" })
    ]);
    await sendText(app, "先安排咖啡路线");
    const before = appliedView(app);
    await sendText(app, "改到远处地标结束");
    assert.deepEqual(appliedView(app), before);
    assert.match(app.messages.textContent, /无法确认“远处地标”的准确位置/);
    assert.match(app.messages.textContent, /原路线已保留/);
    assertReady(app);
});

test("missing nearby cafes produces a clear notice without an invented endpoint", async () => {
    const { app, control } = createRouteApp([
        planPayload(), modifyPayload("change_end", { value: "咖啡馆" }, { end: "咖啡馆" })
    ]);
    await sendText(app, "先安排咖啡路线");
    const before = appliedView(app);
    control.nearby = [];
    await sendText(app, "最后找一家咖啡馆");
    assert.deepEqual(appliedView(app), before);
    assert.match(app.messages.textContent, /未找到合适的“咖啡馆”作为终点/);
    assertReady(app);
});

test("a required bookstore cannot be satisfied by cafes returned for a bookstore search", async () => {
    const { app } = createRouteApp([planPayload({ theme: ["书店"], required_categories: ["书店"] })]);
    await sendText(app, "必须有一家书店");
    assert.doesNotMatch(app.route.textContent, /1. 一号咖啡馆/);
    assert.match(app.messages.textContent, /没有找到可确认的“书店”地点/);
    assert.doesNotMatch(app.messages.textContent, /路线已生效/);
    assertReady(app);
});

test("unverified walking results never publish a straight-line route", async () => {
    const { app, control } = createRouteApp([planPayload()]);
    control.failWalking = true;
    await sendText(app, "从上海图书馆出发逛咖啡馆");
    assert.match(app.messages.textContent, /地图暂时没有返回可核验的步行路线/);
    assert.doesNotMatch(app.messages.textContent, /路线已生效/);
    assert.doesNotMatch(app.route.textContent, /1. 一号咖啡馆/);
    assertReady(app);
});

test("a verified bookstore category survives model filtering and canonical theme search runs first", async () => {
    const payload = { ...planPayload({ theme: ["书店"], required_categories: ["书店"] }), keywords: ["文艺空间"] };
    const { app, control } = createRouteApp([payload], { filter: () => [] });
    control.nearby = [{ title: "衡山和集", tags: ["书店"], point: { lng: 121.441, lat: 31.20 } }];
    await sendText(app, "必须有一家书店");
    assert.equal(control.queries.find(query => query.type === "nearby").query, "书店");
    assert.match(app.route.textContent, /1. 衡山和集/);
    assert.match(app.messages.textContent, /路线已生效/);
});

test("a short coffee route can trim redundant cafes while still satisfying the category", async () => {
    const { app, control } = createRouteApp([planPayload({ duration_minutes: 20 })]);
    control.distance = () => 600;
    control.seconds = () => 600;
    await sendText(app, "20分钟逛咖啡馆");
    assert.equal(app.route.children.length, 2);
    assert.match(app.summary.textContent, /15 分钟.*1 站/);
});

test("deleting a stop after set_stops also clears its previous must-visit constraint", async () => {
    const { app } = createRouteApp([planPayload(),
        modifyPayload("set_stops", { places: ["美罗城", "港汇恒隆广场"] }),
        modifyPayload("remove_stop", { target: "美罗城" })]);
    await sendText(app, "先规划");
    await sendText(app, "只保留美罗城和港汇恒隆广场");
    await sendText(app, "删掉美罗城");
    assert.match(app.route.textContent, /1. 港汇恒隆广场/);
    assert.doesNotMatch(app.route.textContent, /美罗城/);
    await sendText(app, "当前路线");
    assert.deepEqual(app.requests.at(-1).body.trip_state.required_places, ["港汇恒隆广场"]);
});

test("adding a named landmark resolves that exact landmark instead of a fuzzy nearby result", async () => {
    const { app, control, pois } = createRouteApp([planPayload(), modifyPayload("add_stop", { value: "美罗城" })]);
    await sendText(app, "先规划");
    control.nearby = [pois["附近咖啡馆"]];
    control.queries = [];
    await sendText(app, "加上美罗城");
    assert.match(app.route.textContent, /3. 美罗城/);
    assert.doesNotMatch(app.route.textContent, /附近咖啡馆/);
    assert.ok(control.queries.some(query => query.type === "name" && query.query === "美罗城"));
    assert.equal(control.queries.filter(query => query.type === "nearby").length, 0);
});

test("changing a normal theme does not inherit an automatically hardened old category", async () => {
    const next = { ...modifyPayload("change_theme", { value: "书店" }, { theme: ["书店"] }), keywords: ["书店"] };
    const { app, control } = createRouteApp([planPayload(), next]);
    await sendText(app, "先逛咖啡馆");
    control.nearby = [{ title: "独立书店", point: { lng: 121.441, lat: 31.20 } }];
    await sendText(app, "改逛书店");
    assert.match(app.route.textContent, /1. 独立书店/);
    assert.doesNotMatch(app.route.textContent, /咖啡/);
    assert.deepEqual(app.requests[1].body.trip_state.required_categories, []);
});

test("set_stops keeps a fixed end marker so a later addition is inserted before it", async () => {
    const { app, control, pois } = createRouteApp([planPayload({ end: "二号咖啡馆" }),
        modifyPayload("set_stops", { places: ["一号咖啡馆", "二号咖啡馆"] }),
        modifyPayload("add_stop", { value: "咖啡馆" })]);
    await sendText(app, "在二号咖啡馆结束");
    await sendText(app, "只保留一号咖啡馆和二号咖啡馆");
    control.nearby = [pois["附近咖啡馆"]];
    await sendText(app, "加一家咖啡馆");
    assert.match(app.route.textContent, /1. 一号咖啡馆.*2. 附近咖啡馆.*3. 二号咖啡馆/);
    assert.match(app.context.textContent, /终点 · 二号咖啡馆/);
});

test("a first plan with only named places does not add optional nearby stops", async () => {
    const { app, control } = createRouteApp([planPayload({ theme: [], required_places: ["美罗城", "港汇恒隆广场"] })]);
    await sendText(app, "只去美罗城和港汇恒隆广场");
    assert.match(app.route.textContent, /1. 美罗城.*2. 港汇恒隆广场/);
    assert.equal(app.route.children.length, 3);
    assert.equal(control.queries.filter(query => query.type === "nearby").length, 0);
});

for (const metadata of [
    { source: "rule_based" },
    { source: "fallback", fallback_reason: "rule_based" }
]) {
    test(`normal local handling is not a disconnect (${JSON.stringify(metadata)})`, async () => {
        const app = createApp({ chat: () => response({ ...metadata, intent: "chat", reply: "本地指令已经理解。" }) });
        await sendText(app, "请处理这个明确指令");
        assert.equal(app.status.textContent, "本轮本地处理");
        assert.match(app.status.title, /本地规则处理/);
        assert.match(app.messages.textContent, /本地指令已经理解/);
        assert.doesNotMatch(app.messages.textContent, /备用回复|AI 返回格式异常|AI 请求未完成/);
        assertReady(app);
    });
}

test("a transient chat fallback is scoped to that turn and the next model reply clears its status", async () => {
    const app = createApp({ chat: (_url, _options, count) => response(count === 1
        ? { source: "fallback", fallback_reason: "invalid_model_response", intent: "chat", reply: "这次先用基础回复。" }
        : { source: "model", intent: "chat", reply: "下一轮已正常回复。", attempts: 1, recovered: false }) });
    await sendText(app, "第一轮");
    assert.equal(app.status.textContent, "本轮备用回复");
    assert.match(app.status.title, /本次 AI 返回格式异常.*下一条消息仍会重新尝试 AI/);
    assert.doesNotMatch(app.status.textContent, /断联|未连接|不可用/);
    await sendText(app, "第二轮");
    assert.equal(app.status.textContent, "AI 已回复");
    assert.equal(app.status.title, "本次已收到 AI 回复。");
    assert.match(app.messages.textContent, /下一轮已正常回复/);
    assert.equal(app.requests.length, 2);
    assertReady(app);
});

test("a recovered model response reports its automatic retry without showing a disconnect", async () => {
    const app = createApp({ chat: () => response({ source: "model", intent: "chat", reply: "已经收到请求。", attempts: 2, recovered: true }) });
    await sendText(app, "请介绍一下");
    assert.equal(app.status.textContent, "AI 已回复");
    assert.match(app.status.title, /自动重试后已收到 AI 回复/);
    assert.doesNotMatch(app.messages.textContent, /备用回复|无法连接|AI 请求未完成/);
    assert.equal(app.requests.length, 1, "one user send; retry took place on the backend");
    assertReady(app);
});

test("a failed place filter preserves the successful chat model source", async () => {
    const { app } = createRouteApp([planPayload()], {
        filterMetadata: { source: "fallback", fallback_reason: "model_timeout", attempts: 2, recovered: false }
    });
    await sendText(app, "从上海图书馆出发逛咖啡馆");
    assert.equal(app.status.textContent, "AI 已回复 · 基础筛选");
    assert.match(app.status.title, /本次已收到 AI 回复.*地点筛选使用基础规则.*超时/);
    assert.match(app.messages.textContent, /路线已生效/);
    assert.doesNotMatch(app.status.textContent, /断联|未连接|备用回复/);
    await sendText(app, "请继续介绍");
    assert.equal(app.status.textContent, "AI 已回复", "previous filter failure does not leak into the next turn");
    assert.doesNotMatch(app.status.title, /筛选|超时/);
    assertReady(app);
});

test("a filter network failure does not overwrite the chat model's recovered metadata", async () => {
    const { app } = createRouteApp([{ ...planPayload(), attempts: 2, recovered: true }], {
        filter: () => { throw new TypeError("Failed to fetch"); }
    });
    await sendText(app, "从上海图书馆出发逛咖啡馆");
    assert.equal(app.status.textContent, "AI 已回复 · 基础筛选");
    assert.match(app.status.title, /自动重试后已收到 AI 回复.*地点筛选使用基础规则.*网络波动/);
    assert.match(app.messages.textContent, /路线已生效/);
    assertReady(app);
});

test("a network failure allows the next send and its success resets the current status", async () => {
    const app = createApp({ chat: (_url, _options, count) => {
        if (count === 1) throw new TypeError("Failed to fetch");
        return response({ source: "model", intent: "chat", reply: "本次已恢复正常。" });
    } });
    await sendText(app, "请介绍老洋房");
    assert.equal(app.status.textContent, "本次请求未完成");
    assert.equal(app.input.value, "请介绍老洋房");
    assertReady(app);
    app.send.dispatch("click");
    await flush();
    assert.equal(app.status.textContent, "AI 已回复");
    assert.match(app.messages.textContent, /本次已恢复正常/);
    assert.equal(app.requests.length, 2);
    assertReady(app);
});

test("mobile map/chat tabs update selected state and collapse map details without focusing the keyboard", () => {
    const app = createApp({ mobile: true });
    assert.equal(app.appRoot.dataset.mobileView, "map");
    app.chatTab.dispatch("click");
    assert.equal(app.appRoot.dataset.mobileView, "chat");
    assert.equal(app.chatTab.getAttribute("aria-pressed"), "true");
    assert.equal(app.mapTab.getAttribute("aria-pressed"), "false");
    app.input.focus();
    app.panelToggle.dispatch("click");
    assert.equal(app.panel.dataset.expanded, "true");
    assert.equal(app.panelToggle.getAttribute("aria-expanded"), "true");
    assert.equal(app.panelToggle.textContent, "收起详情");
    app.mapTab.dispatch("click");
    assert.equal(app.appRoot.dataset.mobileView, "map");
    assert.equal(app.mapTab.getAttribute("aria-pressed"), "true");
    assert.equal(app.chatTab.getAttribute("aria-pressed"), "false");
    assert.equal(app.panel.dataset.expanded, "false");
    assert.equal(app.panelToggle.getAttribute("aria-expanded"), "false");
    assert.equal(app.panelToggle.textContent, "展开详情");
    assert.equal(app.input.focused, false);
    assert.equal(app.input.blurCount, 1);
    assert.equal(app.input.focusCount, 1);
    app.document.getElementById("map-chat-button").dispatch("click");
    assert.equal(app.appRoot.dataset.mobileView, "chat");
    assert.equal(app.chatTab.getAttribute("aria-pressed"), "true");
});

test("a successful mobile route returns to the map, redraws it, and does not reopen the keyboard", async () => {
    const { app, control } = createRouteApp([planPayload()], { mobile: true });
    app.chatTab.dispatch("click");
    app.input.focus();
    app.panelToggle.dispatch("click");
    await sendText(app, "从上海图书馆出发逛咖啡馆");
    assert.match(app.messages.textContent, /路线已生效/);
    assert.equal(app.appRoot.dataset.mobileView, "map");
    assert.equal(app.panel.dataset.expanded, "false");
    assert.equal(app.mapTab.getAttribute("aria-pressed"), "true");
    assert.equal(app.chatTab.getAttribute("aria-pressed"), "false");
    assert.equal(app.input.focused, false);
    assert.equal(app.input.focusCount, 1, "completion must not focus the now-hidden chat input");
    assert.ok(app.animationFrames.length >= 1, "map repaint scheduled after switching surfaces");
    assert.ok(control.maps[0].viewport.length >= 3);
    assert.equal(app.chatTab.textContent, "对话");
    assertReady(app);
});

test("a mobile chat-only reply stays in chat and keeps the input usable", async () => {
    const app = createApp({ mobile: true });
    app.chatTab.dispatch("click");
    await sendText(app, "你好");
    assert.equal(app.appRoot.dataset.mobileView, "chat");
    assert.equal(app.chatTab.getAttribute("aria-pressed"), "true");
    assert.equal(app.input.focused, true);
    assert.equal(app.input.blurCount || 0, 0);
    assert.equal(app.chatTab.textContent, "对话");
    assertReady(app);
});
