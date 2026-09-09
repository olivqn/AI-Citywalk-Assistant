"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../route-core.js");
const point = { lng: 121.44, lat: 31.20 };
const stop = (name, extra = {}) => ({ name, point: { ...point }, ...extra });
const start = () => stop("上海图书馆", { isStart: true });
const route = (...names) => [start(), ...names.map(name => stop(name))];

test("catalog identity requires exact branch, street number and demo coordinates", () => {
    const entry = { name: "某咖啡（武康路店）", aliases: ["某咖啡武康店"], address: "上海市徐汇区武康路376号" };
    assert.equal(core.matchesCatalogPlace(stop("某咖啡(武康路店)", { address: "上海市徐汇区武康路376号1层" }), entry), true);
    assert.equal(core.matchesCatalogPlace(stop("某咖啡武康店", { address: "武康路376号" }), entry), true);
    for (const poi of [stop("某咖啡(衡山路店)", { address: "武康路376号" }),
        stop(entry.name, { address: "武康路3761号" }), stop(entry.name, { address: "衡山路376号" }),
        stop(entry.name), stop(entry.name, { address: "武康路376号", point: { lng: 120, lat: 30 } })]) {
        assert.equal(core.matchesCatalogPlace(poi, entry), false);
    }
});

test("catalog identity supports documented narrow address ranges without guessing a different door", () => {
    const entry = { name: "武康大楼", aliases: [], address: "上海市徐汇区淮海中路1836—1858号" };
    assert.equal(core.matchesCatalogPlace(stop(entry.name, { address: "淮海中路1850号" }), entry), true);
    assert.equal(core.matchesCatalogPlace(stop(entry.name, { address: "淮海中路1836-1858号" }), entry), true);
    assert.equal(core.matchesCatalogPlace(stop(entry.name, { address: "淮海中路18361号" }), entry), false);
    assert.equal(core.matchesCatalogPlace(stop(entry.name, { address: "淮海中路1859号" }), entry), false);
});

test("UMD works without CommonJS in a browser-like global", () => {
    const sandbox = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../route-core.js"), "utf8"), sandbox);
    assert.equal(typeof sandbox.CitywalkRouteCore.validateRoute, "function");
});

test("normalization removes geography prefixes and punctuation but preserves branch meaning", () => {
    assert.equal(core.normalizeName(" 上海市 徐汇区 美罗城（肇嘉浜路店） "), "美罗城肇嘉浜路店");
    assert.equal(core.normalizeName("上海徐汇 MANNER COFFEE（衡山路店）"), "mannercoffee衡山路店");
    assert.equal(core.normalizeName(null), "");
    assert.notEqual(core.normalizeName("星巴克(图书馆店)"), core.normalizeName("星巴克(衡山路店)"));
});

test("name matching does not fuzz 衡/横 or short/generic words", () => {
    assert.equal(core.samePlace("上海市徐汇区衡山路", "衡山路"), true);
    assert.equal(core.samePlace("衡山路地铁站", "横山路地铁站"), false);
    assert.equal(core.samePlace("花园", "横山树花园"), false);
    assert.equal(core.samePlace("老洋房", "乌鲁木齐路老洋房"), false);
    assert.equal(core.samePlace("武康", "武康大楼"), false);
    assert.equal(core.samePlace("", ""), false);
    assert.equal(core.samePlace("港汇", "港汇恒隆广场"), true);
    assert.equal(core.samePlace("美罗城", "美罗城购物中心"), true);
    assert.equal(core.samePlace("星巴克(上海图书馆店)", "星巴克(衡山路店)"), false);
});

test("demo bounds are explicit and reject invalid or outside coordinates", () => {
    assert.equal(core.inDemoArea(point), true);
    assert.equal(core.inDemoArea({ lng: 121.40, lat: 31.11 }), true);
    assert.equal(core.inDemoArea({ lng: 121.49, lat: 31.225 }), true);
    for (const value of [null, {}, { lng: "121.44", lat: 31.2 }, { lng: NaN, lat: 31.2 },
        { lng: 120.14, lat: 30.24 }, { lng: 121.399, lat: 31.2 }, { lng: 121.44, lat: 31.226 }]) {
        assert.equal(core.inDemoArea(value), false);
    }
});

test("POI validation rejects residential door numbers and non-destinations without discarding named heritage", () => {
    for (const name of ["横山树花园-121号", "横山村花园-232号", "横山树花园121号", "淮海中路1768弄", "232号", "10栋2单元", "公园停车场", "花园物业", "咖啡软件科技有限公司", "花园办公楼"]) {
        assert.equal(core.isUsablePoi(stop(name)), false, name);
    }
    for (const name of ["衡山公园", "淮海中路1768弄优秀历史建筑", "历史建筑(淮海中路1768号)", "武康大楼", "MANNER COFFEE(衡山路店)"]) {
        assert.equal(core.isUsablePoi(stop(name)), true, name);
    }
    assert.equal(core.isUsablePoi(stop("花园", { tags: ["住宅小区"] })), false);
    assert.equal(core.isUsablePoi(stop("衡山公园", { point: { lng: 120, lat: 30 } })), false);
    assert.equal(core.isUsablePoi({ title: "衡山公园", point }), true);
    assert.equal(core.isUsablePoi({ name: "", title: "衡山公园", point }), true);
    assert.equal(core.isUsablePoi({ point }), false);
});

test("category evidence comes from names and tags, never the search keyword or address", () => {
    assert.equal(core.categoryMatches(stop("MANNER COFFEE"), "咖啡"), true);
    assert.equal(core.categoryMatches(stop("衡山和集", { tags: ["书店", "阅读"] }), "书店"), true);
    assert.equal(core.categoryMatches(stop("咖啡馆", { keyword: "书店", detailAddress: "书店旁" }), "书店"), false);
    assert.equal(core.categoryMatches(stop("上海图书馆"), "书店"), false);
    assert.equal(core.categoryMatches(stop("衡山公园"), "花园"), true);
    assert.equal(core.categoryMatches(stop("武康大楼"), "历史建筑"), true);
    assert.equal(core.categoryMatches(stop("美罗城"), "现代建筑"), true);
    assert.equal(core.categoryMatches(stop("未来一号", { categories: ["现代建筑"] }), "现代建筑"), true);
    assert.equal(core.categoryMatches(stop("美罗城"), "真实外星飞船"), false);
    assert.equal(core.categoryMatches(stop("美罗城"), "constructor"), false);
    assert.equal(core.categoryMatches(stop("光景天桥"), "天桥"), true);
});

test("hard distance limits are verified and enforced, including the two observed failures", () => {
    const one = route("罗密欧阳台");
    assert.match(core.validateRoute(one, { max_walk_meters: 1000 }, { distance: 1300, verified: true })[0], /超过.*1000/);
    assert.match(core.validateRoute(one, { max_walk_meters: 500 }, { distance: 600, verified: true })[0], /超过.*500/);
    assert.deepEqual(core.validateRoute(one, { max_walk_meters: 500 }, { distance: 500, verified: true }), []);
    assert.match(core.validateRoute(one, { max_walk_meters: 500 }, { distance: 400, verified: false })[0], /不能确认/);
    assert.match(core.validateRoute(one, { max_walk_meters: 500 }, { verified: true })[0], /不能确认/);
    assert.match(core.validateRoute(one, { max_walk_meters: 500 }, { distance: -5, verified: true })[0], /不能确认/);
    assert.deepEqual(core.validateRoute(one, {}, { distance: 1000, verified: false }), []);
});

test("required places and category exclusions catch the keep-only and no-cafe cases", () => {
    const issues = core.validateRoute(route("光景天桥", "星巴克(上海图书馆店)", "老房子餐厅"), {
        required_places: ["美罗城", "港汇恒隆广场"], excluded_places: ["光景天桥", "咖啡店", "餐厅"]
    }, {});
    assert.equal(issues.length, 5);
    assert(issues.some(issue => /必去地点“美罗城”/.test(issue)));
    assert(issues.some(issue => /排除的“咖啡店”/.test(issue)));
    assert(issues.some(issue => /排除的“餐厅”/.test(issue)));
    assert.deepEqual(core.validateRoute(route("美罗城", "港汇恒隆广场"), { required_places: ["美罗城", "港汇"] }, {}), []);
    assert.match(core.validateRoute(route("光景天桥"), { excluded_places: ["天桥"] }, {})[0], /排除的“天桥”/);
});

test("bookstore coverage cannot be satisfied by a keyword or a library", () => {
    const requested = { required_categories: ["花园", "书店"] };
    const withoutBookstore = [start(), stop("衡山公园"), stop("星巴克", { keyword: "书店" })];
    assert.deepEqual(core.validateRoute(withoutBookstore, requested, {}), ["路线中尚无可确认的“书店”地点。"]);
    const valid = [...withoutBookstore, stop("衡山和集", { tags: ["书店"] })];
    assert.deepEqual(core.validateRoute(valid, requested, {}), []);
});

test("fixed endpoint must be last; clearing it removes the requirement", () => {
    const stops = route("武康大楼", "安福路");
    assert.match(core.validateRoute(stops, { end: "武康大楼" }, {})[0], /最后一站/);
    assert.deepEqual(core.validateRoute(route("安福路", "武康大楼"), { end: "武康大楼" }, {}), []);
    assert.deepEqual(core.validateRoute(stops, { end: null }, {}), []);
    assert.deepEqual(core.validateRoute(stops, { end: "" }, {}), []);
});

test("estimated dwell and walking are compared against requested time, never substituted for it", () => {
    const stops = route("罗密欧阳台", "乌鲁木齐路老洋房");
    assert.equal(core.estimatedVisitMinutes(stops, { duration_minutes: 20 }), 10);
    assert.equal(core.estimatedVisitMinutes(stops, { duration_minutes: 30 }), 10);
    assert.equal(core.estimatedVisitMinutes(stops, { duration_minutes: 31 }), 20);
    assert.equal(core.estimatedVisitMinutes([], {}), 0);
    assert.match(core.validateRoute(stops, { duration_minutes: 20 }, { walkingMinutes: 15 })[0], /约 25 分钟/);
    assert.deepEqual(core.validateRoute(stops, { duration_minutes: 20 }, { walkingMinutes: 10 }), []);
    assert.deepEqual(core.validateRoute(stops, { duration_minutes: 20 }, {}), []);
});

test("empty, out-of-area and non-destination routes produce clear validation failures", () => {
    assert.match(core.validateRoute([], {}, {})[0], /尚未找到/);
    assert.match(core.validateRoute(null, {}, {})[0], /尚未找到/);
    const stops = [stop("起点", { point: { lng: 120.2, lat: 30.1 }, isStart: true }), stop("横山村花园-232号")];
    assert.equal(core.validateRoute(stops, {}, {}).length, 2);
});

test("explicit reordering preserves every unmentioned stop and the original input", () => {
    const original = route("罗密欧阳台", "淮海中路1768弄优秀历史建筑", "安福路", "武康大楼");
    const before = JSON.stringify(original);
    const reordered = core.orderStops(original, ["安福路", "罗密欧阳台"]);
    assert.deepEqual(reordered.map(poi => poi.name), ["上海图书馆", "安福路", "罗密欧阳台", "淮海中路1768弄优秀历史建筑", "武康大楼"]);
    assert.equal(JSON.stringify(original), before);
    assert.equal(reordered[0], original[0]);
    assert.notEqual(reordered, original);
    assert.deepEqual(core.orderStops(original, []), original);
});

test("reordering rejects missing, repeated, ambiguous or invalid instructions without guessing", () => {
    const original = route("美罗城", "港汇恒隆广场");
    assert.throws(() => core.orderStops(original, ["不存在的地点"]), /没有/);
    assert.throws(() => core.orderStops(original, ["港汇", "港汇恒隆广场"]), /重复/);
    assert.throws(() => core.orderStops(original, [""]), /不能为空/);
    assert.throws(() => core.orderStops(original, null), /明确/);
    assert.throws(() => core.orderStops([], ["美罗城"]), /还没有/);
    assert.throws(() => core.orderStops(route("星巴克(衡山路店)", "星巴克(上海图书馆店)"), ["星巴克"]), /多个地点/);
    assert.deepEqual(original.map(poi => poi.name), ["上海图书馆", "美罗城", "港汇恒隆广场"]);
});
